import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunStatus } from './generation-run.entity';

@Injectable()
export class RunsService implements OnModuleInit {
  constructor(
    @InjectRepository(GenerationRun) private readonly runs: Repository<GenerationRun>,
    @InjectRepository(GenerationCandidateGroup) private readonly groups: Repository<GenerationCandidateGroup>,
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
  ) {}

  async onModuleInit() {
    await this.runs.createQueryBuilder().update().set({ status: 'needs_attention', error: { code: 'PROVIDER_STATE_UNCONFIRMED', message: '服务重启后无法确认提供方任务状态' } }).where('status IN (:...statuses)', { statuses: ['queued', 'running'] }).execute();
  }

  async begin(input: Partial<GenerationRun> & Pick<GenerationRun, 'provider' | 'inputSnapshot'>) {
    if (input.idempotencyKey) {
      const existing = await this.runs.findOne({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (stableStringify(existing.inputSnapshot) !== stableStringify(redact(input.inputSnapshot))) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '幂等键已用于不同运行输入' });
        return { run: existing, replay: true };
      }
    }
    const now = Date.now();
    const run = this.runs.create({ status: 'queued', canvasId: null, nodeId: null, shotId: null, parentRunId: null, providerRunId: null, capabilityId: null, capabilityVersion: null, inputAssetIds: [], outputAssetIds: [], outputText: null, outputParts: null, actorType: 'human', actorId: 'web', attemptCount: 1, idempotencyKey: null, error: null, queuedAt: now, startedAt: null, finishedAt: null, ...input, inputSnapshot: redact(input.inputSnapshot) });
    return { run: await this.runs.save(run), replay: false };
  }

  async patch(id: string, patch: Partial<GenerationRun>) {
    await this.runs.update(id, patch as any);
    return this.get(id);
  }

  async finish(id: string, status: GenerationRunStatus, outputAssetIds: string[] = [], error: unknown = null, outputText: string | null = null, outputParts: { positive: string; negative: string } | null = null) {
    const now = Date.now();
    const run = await this.patch(id, { status, outputAssetIds, outputText, outputParts, error, finishedAt: now });
    if (run.canvasId && status === 'succeeded' && (outputAssetIds.length || outputText)) await this.appendCandidates(run, outputAssetIds);
    return this.get(id);
  }

  async get(id: string) {
    const run = await this.runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`运行 ${id} 不存在`);
    return run;
  }

  async getByProviderRunId(providerRunId: string) { return this.runs.findOne({ where: { providerRunId } }); }

  async list(query: Record<string, string | undefined>) {
    const where: FindOptionsWhere<GenerationRun> = {};
    for (const key of ['canvasId', 'nodeId', 'shotId', 'status', 'provider'] as const) if (query[key]) (where as any)[key] = query[key];
    const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const [runs, total] = await this.runs.findAndCount({ where, order: { createdAt: 'DESC' }, skip: (page - 1) * pageSize, take: pageSize });
    const items = await Promise.all(runs.map(async (run) => ({ ...run, candidateGroup: run.canvasId ? await this.group(run.canvasId, run.nodeId, run.shotId) : null })));
    return { items, total, page, pageSize };
  }

  async lineage(id: string) {
    const run = await this.get(id);
    const assetIds = [...new Set([...run.inputAssetIds, ...run.outputAssetIds])];
    const assets = assetIds.length ? await this.assets.find({ where: { id: In(assetIds) } }) : [];
    const parent = run.parentRunId ? await this.runs.findOne({ where: { id: run.parentRunId } }) : null;
    const children = await this.runs.find({ where: { parentRunId: id } });
    return { run, assets, parent, children };
  }

  async group(canvasId: string, nodeId?: string | null, shotId?: string | null) {
    return this.groups.findOne({ where: { canvasId, nodeId: nodeId ?? IsNull(), shotId: shotId ?? IsNull() } as any });
  }

  private async appendCandidates(run: GenerationRun, ids: string[]) {
    let group = await this.group(run.canvasId!, run.nodeId, run.shotId);
    if (!group) group = this.groups.create({ canvasId: run.canvasId!, nodeId: run.nodeId, shotId: run.shotId, candidateAssetIds: [], selectedAssetId: null, selectedRunId: null, approvedAssetId: null });
    group.candidateAssetIds = [...new Set([...group.candidateAssetIds, ...ids])];
    group.selectedRunId = run.id;
    group.selectedAssetId = ids[0] ?? null;
    await this.groups.save(group);
  }

  async choose(canvasId: string, nodeId: string | null, shotId: string | null, assetId: string, approve: boolean, actorType: 'human' | 'agent' = 'agent') {
    const group = await this.group(canvasId, nodeId, shotId);
    if (!group || !group.candidateAssetIds.includes(assetId)) throw new BadRequestException('资产不属于该候选组');
    if (approve && actorType !== 'human') throw new ConflictException({ code: 'HUMAN_APPROVAL_REQUIRED', message: '批准候选需要人工确认' });
    if (group.approvedAssetId && group.approvedAssetId !== assetId) throw new ConflictException({ code: 'APPROVED_ASSET_PROTECTED', message: '已批准资产不可静默替换' });
    group.selectedAssetId = assetId;
    const selectedRun = await this.runs.createQueryBuilder('run').where('run.canvas_id = :canvasId AND run.node_id = :nodeId', { canvasId, nodeId }).orderBy('run.created_at', 'DESC').getMany();
    group.selectedRunId = selectedRun.find((run) => run.outputAssetIds.includes(assetId))?.id ?? group.selectedRunId;
    if (approve) group.approvedAssetId = assetId;
    return this.groups.save(group);
  }

  async chooseText(canvasId: string, nodeId: string, runId: string) {
    const run = await this.get(runId);
    if (run.canvasId !== canvasId || run.nodeId !== nodeId || run.status !== 'succeeded' || !run.outputText) throw new BadRequestException('文字输出不属于该节点的成功历史');
    const group = await this.group(canvasId, nodeId, run.shotId);
    if (!group) throw new BadRequestException('候选组不存在');
    group.selectedRunId = run.id; group.selectedAssetId = null;
    return this.groups.save(group);
  }

  async retry(id: string, idempotencyKey: string) {
    const old = await this.get(id);
    return this.begin({ provider: old.provider, canvasId: old.canvasId, nodeId: old.nodeId, shotId: old.shotId, parentRunId: old.id, capabilityId: old.capabilityId, capabilityVersion: old.capabilityVersion, inputSnapshot: old.inputSnapshot, inputAssetIds: old.inputAssetIds, actorType: old.actorType, actorId: old.actorId, attemptCount: old.attemptCount + 1, idempotencyKey });
  }

  async cancel(id: string) {
    const run = await this.get(id);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    throw new ConflictException({ code: 'CANCEL_NOT_PRECISE', message: run.provider === 'comfyui' ? 'ComfyUI 当前仅支持全局中断，不能通过统一接口伪装为精确取消' : '该提供方运行是同步请求，当前不能精确取消' });
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = /api.?key|authorization|token|secret|password/i.test(key) ? '[REDACTED]' : redact(item);
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
