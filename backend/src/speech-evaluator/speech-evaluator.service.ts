import { BadRequestException, ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
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
const TOOL_VERSIONS: Record<typeof STAGES[number], string> = { funasr: 'funasr-1.4.1/paraformer-zh', 'audio-profile': 'builtin-1', 'pause-timing': 'builtin-1', 'pitch-energy': 'builtin-1', wespeaker: 'wespeaker-campplus', utmosv2: 'utmosv2-1.3.1.dev0' };

class EvaluationCancelled extends Error {}

@Injectable()
export class SpeechEvaluatorService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SpeechEvaluatorService.name);
  private readonly active = new Set<string>();
  private readonly cancellationRequested = new Set<string>();
  constructor(@InjectRepository(SpeechEvaluationItem) private readonly items: Repository<SpeechEvaluationItem>,
    private readonly scheduler: LocalComputeSchedulerService, private readonly assets: AssetsService, private readonly runs: RunsService,
    private readonly toolRunner: SpeechToolRunnerService) {}

  onModuleInit() {
    this.scheduler.registerProvider('speech-evaluator', { retainAfterLease: false, prepare: () => this.toolRunner.prepare(), release: () => this.toolRunner.release() });
    this.runs.registerCancelHandler('speech-evaluator', (runId) => this.cancel(runId));
  }

  async onApplicationBootstrap() {
    const recoverable = await this.runs.list({ provider: 'speech-evaluator', status: 'needs_attention', pageSize: '100' });
    for (const run of recoverable.items) {
      const items = await this.list(run.id);
      if (!items.length || !items.some((item) => item.status === 'queued' || item.status === 'running')) continue;
      let compatible = true;
      for (const item of items) for (const stage of STAGES) {
        const state = item.stages[stage];
        if (state?.status === 'running') item.stages[stage] = { status: 'pending' };
        if (['succeeded', 'unavailable'].includes(state?.status) && state.toolVersion !== TOOL_VERSIONS[stage]) compatible = false;
      }
      if (!compatible) continue;
      for (const item of items) await this.items.save(item);
      await this.runs.patch(run.id, { status: 'queued', error: null, finishedAt: null });
      this.start(run.id);
    }
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

  async cancel(runId: string) {
    const run = await this.runs.get(runId);
    if (run.provider !== 'speech-evaluator') throw new BadRequestException('不是语音评价 Run');
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    if (!this.active.has(runId)) throw new ConflictException({ code: 'CANCEL_NOT_ACTIVE', message: '评价尚未进入可取消执行阶段' });
    this.cancellationRequested.add(runId); this.toolRunner.cancel(runId);
    return { ...run, cancellationRequested: true };
  }

  async list(runId: string) { return this.items.find({ where: { evaluationRunId: runId }, order: { position: 'ASC' } }); }

  private async execute(runId: string) {
    let lease; let failure: unknown;
    try {
      this.toolRunner.clearCancellation(runId); this.cancellationRequested.delete(runId);
      lease = await this.scheduler.acquire('speech-evaluator', runId);
      await this.runs.patch(runId, { status: 'running', startedAt: Date.now() });
      const items = await this.list(runId);
      for (const item of items) if (!['succeeded', 'cancelled'].includes(item.status)) { item.status = 'running'; item.startedAt ??= Date.now(); await this.items.save(item); }
      for (const stage of STAGES) {
        this.throwIfCancelled(runId);
        if (stage === 'funasr' || stage === 'wespeaker' || stage === 'utmosv2') await this.runModelStage(items, stage);
        else for (const item of items) { this.throwIfCancelled(runId); if (!['succeeded', 'unavailable'].includes(item.stages[stage]?.status)) await this.runStage(item, stage); }
      }
      for (const item of items) {
        item.status = 'succeeded'; item.finishedAt = Date.now(); item.finalResult = this.summarize(item); await this.items.save(item);
      }
      const ranking = [...items].sort((a, b) => comparisonScore(b) - comparisonScore(a)).map((item, index) => ({ rank: index + 1, itemId: item.id, assetId: item.targetAssetId, comparisonScore: comparisonScore(item), normalizedScores: normalizedScores(item), issues: locateIssues(item) }));
      await this.runs.finish(runId, 'succeeded', [], null, JSON.stringify({ version: 2, scoringRule: 'speech-evaluator-relative-v2', conclusionStatus: 'evaluation_complete_unthresholded', ranking, recommendation: ranking.length > 1 ? `当前批次相对排序首选第 ${ranking[0].rank} 名；中文 MOS 阈值标定前仍需结合试听确认` : '单候选已完成测量；中文 MOS 阈值标定前需结合试听确认', items: items.map((item) => ({ itemId: item.id, assetId: item.targetAssetId, result: item.finalResult })) }));
    } catch (error) {
      if (error instanceof EvaluationCancelled) {
        for (const item of await this.list(runId)) if (['queued', 'running'].includes(item.status)) { item.status = 'cancelled'; item.finishedAt = Date.now(); await this.items.save(item); }
        await this.runs.finish(runId, 'cancelled', [], { code: 'EVALUATION_CANCELLED', message: '已在最近的安全工具/音频边界取消' });
        return;
      }
      failure = error; this.logger.error(`语音评价 ${runId} 失败：${(error as Error).message}`);
      for (const item of await this.list(runId)) if (['queued', 'running'].includes(item.status)) {
        item.status = 'failed'; item.finishedAt = Date.now(); item.error = { code: 'BATCH_ABORTED', cause: serializeError(error) }; await this.items.save(item);
      }
      await this.runs.finish(runId, 'failed', [], serializeError(error));
    } finally { this.cancellationRequested.delete(runId); this.toolRunner.clearCancellation(runId); if (lease) await lease.release(failure); }
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
    const pending = items.filter((item) => !['succeeded', 'unavailable'].includes(item.stages[stage]?.status));
    if (!pending.length) return;
    try {
      const inputs = [];
      for (const item of pending) {
        const target = await this.assets.read(item.targetAssetId);
        const reference = item.referenceAssetId ? await this.assets.read(item.referenceAssetId) : undefined;
        inputs.push({ path: target.absPath, referencePath: reference?.absPath, targetText: item.targetText ?? undefined });
      }
      const result = await this.toolRunner.run(stage, inputs, pending[0].evaluationRunId, async (event) => {
        const item = pending[event.index]; if (!item) throw new Error(`${stage} 返回非法音频索引 ${event.index}`);
        if (event.status === 'started') item.stages[stage] = { status: 'running', startedAt: Date.now(), toolVersion: TOOL_VERSIONS[stage] };
        else { const output = event.result ?? {}; item.stages[stage] = { status: output.status === 'unavailable' ? 'unavailable' : 'succeeded', startedAt: item.stages[stage].startedAt, finishedAt: Date.now(), toolVersion: TOOL_VERSIONS[stage], metrics: output }; }
        await this.items.save(item);
      });
      if (result.cancelled) throw new EvaluationCancelled('收到取消请求');
      if (result.items.length !== pending.length) throw new Error(`${stage} 返回 ${result.items.length} 项，预期 ${pending.length} 项`);
    } catch (error) {
      if (!(error instanceof EvaluationCancelled)) for (const item of pending) if (item.stages[stage]?.status === 'running') { item.stages[stage] = { ...item.stages[stage], status: 'failed', finishedAt: Date.now(), error: serializeError(error) }; await this.items.save(item); }
      throw error;
    }
  }

  private throwIfCancelled(runId: string) { if (this.cancellationRequested.has(runId)) throw new EvaluationCancelled('收到取消请求'); }

  private summarize(item: SpeechEvaluationItem) {
    const speechRate = speechRateMetrics(item); const issues = locateIssues(item);
    return { version: 2, scoringRule: 'speech-evaluator-relative-v2', technicalScore: technicalScore(item), normalizedScores: normalizedScores(item), measurements: item.stages,
      contentAccuracy: item.stages.funasr?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.funasr.metrics ?? {}) } : { status: 'unavailable', reason: 'FunASR 未产生可用结果' },
      pauseAndSpeechRate: speechRate,
      speakerSimilarity: item.stages.wespeaker?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.wespeaker.metrics ?? {}) } : { status: 'unavailable', reason: item.referenceAssetId ? 'WeSpeaker 未产生可用结果' : '未提供参考音频' },
      naturalness: item.stages.utmosv2?.status === 'succeeded' ? { status: 'succeeded', ...(item.stages.utmosv2.metrics ?? {}), calibration: 'uncalibrated-zh' } : { status: 'unavailable', reason: 'UTMOSv2 未产生可用结果' },
      issues, decision: { status: 'evaluation_complete_unthresholded', suggestRegeneration: null, recommendation: issues.length ? `检测到 ${issues.length} 类可定位问题；中文项目阈值完成标定前仅供人工/后续决策参考` : '未发现规则化客观异常；中文项目阈值完成标定前仍不自动触发重生成' } };
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

function normalizedScores(item: SpeechEvaluationItem) {
  const funasr = item.stages.funasr?.metrics as { cer?: number | null } | undefined;
  const speaker = item.stages.wespeaker?.metrics as { cosineSimilarity?: number } | undefined;
  const mos = item.stages.utmosv2?.metrics as { predictedMos?: number } | undefined;
  const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
  return {
    signalHealth: technicalScore(item),
    contentAccuracy: typeof funasr?.cer === 'number' ? clamp((1 - funasr.cer) * 100) : null,
    speakerSimilarity: typeof speaker?.cosineSimilarity === 'number' ? clamp(speaker.cosineSimilarity * 100) : null,
    naturalness: typeof mos?.predictedMos === 'number' ? clamp(((mos.predictedMos - 1) / 4) * 100) : null,
  };
}

function comparisonScore(item: SpeechEvaluationItem) {
  const values = Object.values(normalizedScores(item)).filter((value): value is number => typeof value === 'number');
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : 0;
}

function speechRateMetrics(item: SpeechEvaluationItem) {
  const asr = item.stages.funasr?.metrics as { recognizedNormalized?: string; timestamps?: number[][] } | undefined;
  const pauses = item.stages['pause-timing']?.metrics as { pauseCount?: number; silenceMs?: number; silenceRatio?: number } | undefined;
  const timestamps = asr?.timestamps ?? []; const first = timestamps[0]?.[0]; const last = timestamps[timestamps.length - 1]?.[1];
  const activeMs = typeof first === 'number' && typeof last === 'number' ? Math.max(1, last - first - Number(pauses?.silenceMs ?? 0)) : null;
  const chars = asr?.recognizedNormalized?.length ?? 0;
  return { status: chars && activeMs ? 'succeeded' : 'unavailable', recognizedCharacters: chars || null, activeSpeechMs: activeMs, charactersPerSecond: activeMs ? Math.round(chars / (activeMs / 1000) * 100) / 100 : null, pauseCount: pauses?.pauseCount ?? null, silenceRatio: pauses?.silenceRatio ?? null };
}

function locateIssues(item: SpeechEvaluationItem) {
  const issues: Array<Record<string, unknown>> = [];
  const profile = item.stages['audio-profile']?.metrics as { clippedSampleRatio?: number; rmsDbfs?: number } | undefined;
  const pauses = item.stages['pause-timing']?.metrics as { silenceRatio?: number; pauses?: Array<{ startMs: number; endMs: number; durationMs: number }> } | undefined;
  const asr = item.stages.funasr?.metrics as { cer?: number | null } | undefined;
  if (Number(profile?.clippedSampleRatio ?? 0) > .001) issues.push({ code: 'CLIPPING', dimension: 'signal', severity: 'high', value: profile?.clippedSampleRatio });
  if (Number(profile?.rmsDbfs ?? -20) < -35) issues.push({ code: 'LOW_LEVEL', dimension: 'signal', severity: 'medium', value: profile?.rmsDbfs });
  if (Number(pauses?.silenceRatio ?? 0) > .55) issues.push({ code: 'EXCESSIVE_SILENCE', dimension: 'timing', severity: 'medium', value: pauses?.silenceRatio });
  const longPauses = (pauses?.pauses ?? []).filter((pause) => pause.durationMs >= 1200);
  if (longPauses.length) issues.push({ code: 'LONG_PAUSES', dimension: 'timing', severity: 'medium', segments: longPauses });
  if (typeof asr?.cer === 'number' && asr.cer > .15) issues.push({ code: 'CONTENT_MISMATCH', dimension: 'content', severity: 'high', value: asr.cer });
  return issues;
}
