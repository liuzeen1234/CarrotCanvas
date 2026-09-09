import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetsService } from '../assets/assets.service';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { RunsService } from '../runs/runs.service';
import { SpeechEvaluationItem, SpeechEvaluationStageResult } from './speech-evaluation.entity';
import { audioProfile, decodeWav, pauseTiming, pitchEnergy } from './wav-analysis';
import { SpeechToolRunnerService } from './speech-tool-runner.service';

export interface EvaluationTarget { assetId: string; sourceRunId?: string; referenceAssetId?: string; targetText?: string }

const STAGES = ['funasr', 'audio-profile', 'pause-timing', 'pitch-energy', 'wespeaker', 'utmosv2'] as const;

@Injectable()
export class SpeechEvaluatorService implements OnModuleInit {
  private readonly logger = new Logger(SpeechEvaluatorService.name);
  private readonly active = new Set<string>();
  constructor(@InjectRepository(SpeechEvaluationItem) private readonly items: Repository<SpeechEvaluationItem>,
    private readonly scheduler: LocalComputeSchedulerService, private readonly assets: AssetsService, private readonly runs: RunsService,
    private readonly toolRunner: SpeechToolRunnerService) {}

  onModuleInit() {
    this.scheduler.registerProvider('speech-evaluator', { retainAfterLease: false, prepare: async () => undefined, release: async () => undefined });
  }

  async create(runId: string, canvasId: string, targets: EvaluationTarget[]) {
    if (!targets.length) throw new BadRequestException('至少需要一条目标语音');
    const rows: SpeechEvaluationItem[] = [];
    for (const [position, target] of targets.entries()) {
      const audio = await this.assets.read(target.assetId);
      if (audio.asset.canvasId !== canvasId || audio.asset.kind !== 'audio') throw new BadRequestException(`目标资产 ${target.assetId} 不是当前画布音频`);
      if (target.referenceAssetId) { const reference = await this.assets.read(target.referenceAssetId); if (reference.asset.canvasId !== canvasId || reference.asset.kind !== 'audio') throw new BadRequestException(`参考资产 ${target.referenceAssetId} 不是当前画布音频`); }
      const stages: Record<string, SpeechEvaluationStageResult> = Object.fromEntries(STAGES.map((stage) => [stage, { status: 'pending' as const }]));
      rows.push(this.items.create({ evaluationRunId: runId, position, sourceRunId: target.sourceRunId ?? null,
        targetAssetId: target.assetId, referenceAssetId: target.referenceAssetId ?? null, targetText: target.targetText?.trim() || null,
        status: 'queued', stages, finalResult: null,
        error: null, startedAt: null, finishedAt: null }));
    }
    return this.items.save(rows);
  }

  start(runId: string) { if (this.active.has(runId)) return; this.active.add(runId); void this.execute(runId).finally(() => this.active.delete(runId)); }

  async list(runId: string) { return this.items.find({ where: { evaluationRunId: runId }, order: { position: 'ASC' } }); }

  private async execute(runId: string) {
    let lease; let failure: unknown;
    try {
      lease = await this.scheduler.acquire('speech-evaluator', runId);
      await this.runs.patch(runId, { status: 'running', startedAt: Date.now() });
      const items = await this.list(runId);
      for (const item of items) { item.status = 'running'; item.startedAt = Date.now(); await this.items.save(item); }
      for (const stage of STAGES) {
        if (stage === 'funasr' || stage === 'wespeaker' || stage === 'utmosv2') await this.runModelStage(items, stage);
        else for (const item of items) await this.runStage(item, stage);
      }
      for (const item of items) {
        item.status = 'succeeded'; item.finishedAt = Date.now(); item.finalResult = this.summarize(item); await this.items.save(item);
      }
      const ranking = [...items].sort((a, b) => technicalScore(b) - technicalScore(a)).map((item, index) => ({ rank: index + 1, itemId: item.id, assetId: item.targetAssetId, technicalScore: technicalScore(item) }));
      await this.runs.finish(runId, 'succeeded', [], null, JSON.stringify({ version: 1, conclusionStatus: 'evaluation_complete_unthresholded', ranking, items: items.map((item) => ({ itemId: item.id, assetId: item.targetAssetId, result: item.finalResult })) }));
    } catch (error) {
      failure = error; this.logger.error(`语音评价 ${runId} 失败：${(error as Error).message}`);
      for (const item of await this.list(runId)) if (['queued', 'running'].includes(item.status)) {
        item.status = 'failed'; item.finishedAt = Date.now(); item.error = { code: 'BATCH_ABORTED', cause: serializeError(error) }; await this.items.save(item);
      }
      await this.runs.finish(runId, 'failed', [], serializeError(error));
    } finally { if (lease) await lease.release(failure); }
  }

  private async runStage(item: SpeechEvaluationItem, stage: typeof STAGES[number]) {
    const state = item.stages[stage]; state.status = 'running'; state.startedAt = Date.now(); state.toolVersion = 'builtin-1'; await this.items.save(item);
    try {
      const { absPath } = await this.assets.read(item.targetAssetId); const wav = await decodeWav(absPath);
      state.metrics = stage === 'audio-profile' ? audioProfile(wav) : stage === 'pause-timing' ? pauseTiming(wav) : pitchEnergy(wav);
      state.status = 'succeeded'; state.finishedAt = Date.now(); await this.items.save(item);
    } catch (error) {
      state.status = 'failed'; state.finishedAt = Date.now(); state.error = serializeError(error); item.status = 'failed'; item.error = { stage, ...serializeError(error) }; item.finishedAt = Date.now(); await this.items.save(item); throw error;
    }
  }

  private async runModelStage(items: SpeechEvaluationItem[], stage: 'funasr' | 'wespeaker' | 'utmosv2') {
    const startedAt = Date.now();
    for (const item of items) { item.stages[stage] = { status: 'running', startedAt, toolVersion: stage === 'funasr' ? 'funasr-1.4.1/paraformer-zh' : stage === 'wespeaker' ? 'wespeaker-campplus' : 'utmosv2-1.3.1.dev0' }; await this.items.save(item); }
    try {
      const inputs = [];
      for (const item of items) {
        const target = await this.assets.read(item.targetAssetId);
        const reference = item.referenceAssetId ? await this.assets.read(item.referenceAssetId) : undefined;
        inputs.push({ path: target.absPath, referencePath: reference?.absPath, targetText: item.targetText ?? undefined });
      }
      const outputs = await this.toolRunner.run(stage, inputs);
      if (outputs.length !== items.length) throw new Error(`${stage} 返回 ${outputs.length} 项，预期 ${items.length} 项`);
      for (const [index, item] of items.entries()) {
        const output = outputs[index]; const unavailable = output.status === 'unavailable';
        item.stages[stage] = { status: unavailable ? 'unavailable' : 'succeeded', startedAt, finishedAt: Date.now(),
          toolVersion: item.stages[stage].toolVersion, metrics: output }; await this.items.save(item);
      }
    } catch (error) {
      for (const item of items) { item.stages[stage] = { ...item.stages[stage], status: 'failed', finishedAt: Date.now(), error: serializeError(error) }; await this.items.save(item); }
      throw error;
    }
  }

  private summarize(item: SpeechEvaluationItem) {
    return { version: 1, technicalScore: technicalScore(item), measurements: item.stages,
      contentAccuracy: item.stages.funasr?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.funasr.metrics ?? {}) } : { status: 'unavailable', reason: 'FunASR 未产生可用结果' },
      speakerSimilarity: item.stages.wespeaker?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.wespeaker.metrics ?? {}) } : { status: 'unavailable', reason: item.referenceAssetId ? 'WeSpeaker 未产生可用结果' : '未提供参考音频' },
      naturalness: item.stages.utmosv2?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.utmosv2.metrics ?? {}), calibration: 'uncalibrated-zh' } : { status: 'unavailable', reason: 'UTMOSv2 未产生可用结果' },
      decision: { status: 'evaluation_complete_unthresholded', recommendation: '各维度已完成测量；中文项目阈值完成标定前，仅输出证据，不自动触发重生成' } };
  }
}

function serializeError(error: unknown): Record<string, unknown> { return { message: error instanceof Error ? error.message : String(error) }; }

function technicalScore(item: SpeechEvaluationItem): number {
  const profile = item.stages['audio-profile']?.metrics as { clippedSampleRatio?: number; rmsDbfs?: number } | undefined;
  const pauses = item.stages['pause-timing']?.metrics as { silenceRatio?: number } | undefined;
  const pitch = item.stages['pitch-energy']?.metrics as { voicedFrameCount?: number } | undefined;
  let score = 100;
  score -= Math.min(35, Number(profile?.clippedSampleRatio ?? 0) * 3500);
  const db = Number(profile?.rmsDbfs ?? -100); if (db < -35) score -= Math.min(25, (-35 - db) * 1.5); if (db > -3) score -= Math.min(20, (db + 3) * 5);
  const silence = Number(pauses?.silenceRatio ?? 0); if (silence > .55) score -= Math.min(20, (silence - .55) * 40);
  if (!Number(pitch?.voicedFrameCount)) score -= 20;
  return Math.max(0, Math.round(score * 10) / 10);
}
