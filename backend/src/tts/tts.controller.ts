import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { promises as fs } from 'fs';
import { AssetsService } from '../assets/assets.service';
import { CanvasService } from '../canvas/canvas.service';
import { GpuSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { RunsService } from '../runs/runs.service';
import { TtsClientService, TtsProvider } from './tts-client.service';
import { TtsProcessManagerService } from './tts-process-manager.service';

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
export class TtsController {
  constructor(
    private readonly client: TtsClientService,
    private readonly scheduler: GpuSchedulerService,
    private readonly runs: RunsService,
    private readonly assets: AssetsService,
    private readonly canvas: CanvasService,
    private readonly processes: TtsProcessManagerService,
  ) {}

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
    if (!body.text?.trim()) throw new BadRequestException('配音文本不能为空');
    if (!body.canvasId || !body.referenceAssetId) throw new BadRequestException('缺少画布或参考音频');
    if (body.provider === 'cosyvoice3' && !body.referenceText?.trim()) throw new BadRequestException('CosyVoice 3 需要参考音频对应文本');
    await this.canvas.assertWriteAccess(body.canvasId, body);
    const reference = await this.assets.read(body.referenceAssetId);
    if (reference.asset.canvasId !== body.canvasId || reference.asset.kind !== 'audio') throw new BadRequestException('参考音频必须属于当前画布');
    const emotion = body.emotionReferenceAssetId ? await this.assets.read(body.emotionReferenceAssetId) : null;
    if (emotion && (emotion.asset.canvasId !== body.canvasId || emotion.asset.kind !== 'audio')) throw new BadRequestException('情绪参考音频必须属于当前画布');
    const inputAssetIds = [body.referenceAssetId, ...(body.emotionReferenceAssetId ? [body.emotionReferenceAssetId] : [])];
    const snapshot = { provider: body.provider, text: body.text.trim(), referenceAssetId: body.referenceAssetId,
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
      const audio = await this.client.infer(body.provider, {
        ...snapshot,
        referenceAudioBase64: (await fs.readFile(reference.absPath)).toString('base64'),
        emotionReferenceAudioBase64: emotion ? (await fs.readFile(emotion.absPath)).toString('base64') : null,
      });
      const asset = await this.assets.saveGenerated({ canvasId: body.canvasId, nodeId: body.nodeId ?? null,
        runPromptId: begun.run.id, workflowId: body.provider, kind: 'audio', buffer: audio.buffer,
        originName: `${body.provider}-${begun.run.id}.wav`, mime: audio.mime });
      const run = await this.runs.finish(begun.run.id, 'succeeded', [asset.id]);
      return { run, asset: { assetId: asset.id, url: `/api/assets/${asset.id}`, kind: 'audio' } };
    } catch (error) {
      failure = error;
      await this.runs.finish(begun.run.id, 'failed', [], { message: (error as Error).message });
      throw error;
    } finally {
      await lease.release(failure);
    }
  }
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
