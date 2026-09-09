import { BadRequestException, Body, Controller, Get, OnModuleInit, Post } from '@nestjs/common';
import { promises as fs } from 'fs';
import { AssetsService } from '../assets/assets.service';
import { CanvasService } from '../canvas/canvas.service';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { RunsService } from '../runs/runs.service';
import { TtsClientService, TtsProvider } from './tts-client.service';
import { TtsProcessManagerService } from './tts-process-manager.service';
import { concatenatePcmWav, parsePausePlan, PAUSE_SYNTAX_VERSION, PausePlanSegment } from './pause-plan';

interface TtsRunBody {
  provider: TtsProvider;
  text: string;
  canvasId: string;
  nodeId?: string;
  referenceAssetId: string;
  referenceText?: string;
  emotionReferenceAssetId?: string;
  instruction?: string;
  speed?: number;
  targetDurationMs?: number;
  leaseToken: string;
  leaseEpoch: number;
  expectedRevision: number;
  idempotencyKey?: string;
  actorType?: 'human' | 'agent';
  actorId?: string;
}

@Controller('tts')
export class TtsController implements OnModuleInit {
  private readonly cancelRequested = new Set<string>();
  constructor(
    private readonly client: TtsClientService,
    private readonly scheduler: LocalComputeSchedulerService,
    private readonly runs: RunsService,
    private readonly assets: AssetsService,
    private readonly canvas: CanvasService,
    private readonly processes: TtsProcessManagerService,
  ) {}

  onModuleInit() {
    for (const provider of ['cosyvoice3', 'indextts2'] as const) this.runs.registerCancelHandler(provider, async (runId) => {
      const run = await this.runs.get(runId);
      if (!['queued', 'running'].includes(run.status)) return run;
      this.cancelRequested.add(runId);
      return this.runs.patch(runId, { error: { code: 'CANCEL_REQUESTED', message: '将在当前语音片段结束后取消' } });
    });
  }

  @Get('providers')
  async providers() {
    const items = await Promise.all((['cosyvoice3', 'indextts2'] as const).map(async (provider) => {
      const health = await this.processes.health(provider);
      return { provider, available: true, running: !!health, health };
    }));
    return { providers: items };
  }

  @Post('runs')
  async run(@Body() body: TtsRunBody) {
    if (!['cosyvoice3', 'indextts2'].includes(body.provider)) throw new BadRequestException('不支持的 TTS Provider');
    const plan = parsePausePlan(body.text);
    if (!body.canvasId || !body.referenceAssetId) throw new BadRequestException('缺少画布或参考音频');
    if (body.provider === 'cosyvoice3' && !body.referenceText?.trim()) throw new BadRequestException('CosyVoice 3 需要参考音频对应文本');
    await this.canvas.assertWriteAccess(body.canvasId, body);
    const reference = await this.assets.read(body.referenceAssetId);
    if (reference.asset.canvasId !== body.canvasId || reference.asset.kind !== 'audio') throw new BadRequestException('参考音频必须属于当前画布');
    const emotion = body.emotionReferenceAssetId ? await this.assets.read(body.emotionReferenceAssetId) : null;
    if (emotion && (emotion.asset.canvasId !== body.canvasId || emotion.asset.kind !== 'audio')) throw new BadRequestException('情绪参考音频必须属于当前画布');
    const inputAssetIds = [body.referenceAssetId, ...(body.emotionReferenceAssetId ? [body.emotionReferenceAssetId] : [])];
    const snapshot = { provider: body.provider, text: body.text, pauseSyntaxVersion: PAUSE_SYNTAX_VERSION, segments: plan,
      execution: initialExecution(plan), referenceAssetId: body.referenceAssetId,
      referenceText: body.referenceText?.trim() ?? null,
      emotionReferenceAssetId: body.emotionReferenceAssetId ?? null, instruction: body.instruction ?? null,
      speed: body.speed ?? 1, targetDurationMs: body.targetDurationMs ?? null };
    const begun = await this.runs.begin({ provider: body.provider, canvasId: body.canvasId, nodeId: body.nodeId ?? null,
      inputSnapshot: snapshot, inputAssetIds, actorType: body.actorType ?? 'human', actorId: body.actorId ?? 'web',
      idempotencyKey: body.idempotencyKey ?? null, capabilityId: body.provider, capabilityVersion: 'modelscope' });
    if (begun.replay && !takeoverRetryable(begun.run)) return { run: begun.run, replay: true };
    if (begun.replay) begun.run = await this.runs.patch(begun.run.id, {
      status: 'queued', error: null, finishedAt: null, attemptCount: begun.run.attemptCount + 1,
    });
    let lease;
    try { lease = await this.scheduler.acquire(body.provider, begun.run.id); }
    catch (error) {
      await this.runs.finish(begun.run.id, 'failed', [], schedulerError(error));
      throw error;
    }
    let failure: unknown;
    try {
      await this.runs.patch(begun.run.id, { status: 'running', startedAt: Date.now() });
      const common = { ...snapshot, referenceAudioBase64: (await fs.readFile(reference.absPath)).toString('base64'), emotionReferenceAudioBase64: emotion ? (await fs.readFile(emotion.absPath)).toString('base64') : null };
      const wavParts: Array<{ type: 'speech'; wav: Buffer } | { type: 'silence'; durationMs: number }> = [];
      const execution = initialExecution(plan); let speechPosition = 0;
      for (let position = 0; position < plan.length; position += 1) {
        const segment = plan[position];
        if (segment.type === 'silence') { wavParts.push(segment); continue; }
        this.throwIfCancelled(begun.run.id);
        execution.stage = 'synthesis'; execution.currentSpeechSegment = ++speechPosition;
        execution.segments[position] = { ...execution.segments[position], status: 'running', startedAt: Date.now() };
        await this.runs.patch(begun.run.id, { inputSnapshot: { ...snapshot, execution } });
        const audio = await this.client.infer(body.provider, { ...common, text: segment.text });
        const decoded = concatenatePcmWav([{ type: 'speech', wav: audio.buffer }]);
        execution.segments[position] = { ...execution.segments[position], status: 'succeeded', durationMs: decoded.durationMs, sampleRate: decoded.format.sampleRate, finishedAt: Date.now() };
        wavParts.push({ type: 'speech', wav: audio.buffer });
        await this.runs.patch(begun.run.id, { inputSnapshot: { ...snapshot, execution } });
        this.throwIfCancelled(begun.run.id);
      }
      execution.stage = 'concatenating'; await this.runs.patch(begun.run.id, { inputSnapshot: { ...snapshot, execution } });
      const audio = concatenatePcmWav(wavParts);
      execution.stage = 'saving'; execution.concat = { toolVersion: audio.toolVersion, durationMs: audio.durationMs, format: audio.format, segments: audio.segments };
      await this.runs.patch(begun.run.id, { inputSnapshot: { ...snapshot, execution } });
      const asset = await this.assets.saveGenerated({ canvasId: body.canvasId, nodeId: body.nodeId ?? null,
        runPromptId: begun.run.id, workflowId: body.provider, kind: 'audio', buffer: audio.buffer,
        originName: `${body.provider}-${begun.run.id}.wav`, mime: 'audio/wav' });
      execution.stage = 'succeeded'; execution.finalAssetId = asset.id;
      await this.runs.patch(begun.run.id, { inputSnapshot: { ...snapshot, execution } });
      const run = await this.runs.finish(begun.run.id, 'succeeded', [asset.id]);
      return { run, asset: { assetId: asset.id, url: `/api/assets/${asset.id}`, kind: 'audio' } };
    } catch (error) {
      failure = error;
      const cancelled = error instanceof TtsCancelledError;
      await this.runs.finish(begun.run.id, cancelled ? 'cancelled' : 'failed', [], { code: cancelled ? 'RUN_CANCELLED' : 'TTS_RUN_FAILED', message: (error as Error).message });
      throw error;
    } finally {
      this.cancelRequested.delete(begun.run.id);
      await lease.release(failure);
    }
  }

  private throwIfCancelled(runId: string) { if (this.cancelRequested.has(runId)) throw new TtsCancelledError(); }
}

class TtsCancelledError extends Error { constructor() { super('配音已在安全片段边界取消'); } }

function initialExecution(plan: PausePlanSegment[]) {
  return { policy: 'speech-segment-serial-v1', stage: 'queued', speechSegmentCount: plan.filter((item) => item.type === 'speech').length, currentSpeechSegment: 0,
    segments: plan.map((item) => item.type === 'speech' ? { type: 'speech', text: item.text, status: 'pending' } : { type: 'silence', targetDurationMs: item.durationMs, status: 'planned' }) } as any;
}

function schedulerError(error: unknown) {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.();
  if (typeof response === 'object' && response) return response;
  const details = (error as Error & { details?: unknown } | null)?.details;
  return typeof details === 'object' && details ? details : { message: (error as Error).message };
}

function takeoverRetryable(run: { status: string; providerRunId?: string | null; error?: unknown }) {
  return run.status === 'failed' && !run.providerRunId
    && (run.error as { code?: string } | null)?.code === 'COMFYUI_TAKEOVER_REQUIRED';
}
