import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetsService } from '../assets/assets.service';
import { CanvasService, LeaseProof } from '../canvas/canvas.service';
import { GenerationCandidateGroup, GenerationRun } from './generation-run.entity';

export interface RecoverRunInput extends Partial<LeaseProof> {
  assetId: string;
  reason: string;
  evidence: string;
}

@Injectable()
export class RunRecoveryService {
  private recoveryQueue: Promise<void> = Promise.resolve();
  constructor(
    @InjectRepository(GenerationRun) private readonly runs: Repository<GenerationRun>,
    private readonly canvas: CanvasService,
    private readonly assets: AssetsService,
  ) {}

  /** Read-only discovery. Records facts and attributed notes, never infers provider success. */
  async suggest(sourceRunId: string, requestedAssetId?: string) {
    const source = await this.runs.findOneBy({ id: sourceRunId });
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: '原 Run 不存在' });
    if (!source.canvasId || !source.nodeId || source.recovery || !['failed', 'cancelled', 'needs_attention'].includes(source.status)) {
      throw new ConflictException({ code: 'RUN_NOT_RECOVERABLE', message: '该 Run 不可补录' });
    }
    const doc = await this.canvas.findOne(source.canvasId);
    const node = doc.graph.nodes.find((item: any) => item.id === source.nodeId) as any;
    const assetId = requestedAssetId?.trim() || node?.data?.lastAssets?.[0]?.assetId;
    const errorMessage = typeof (source.error as any)?.message === 'string' ? (source.error as any).message.slice(0, 1000) : '';
    const reason = `原请求${source.status === 'failed' ? '失败' : source.status === 'cancelled' ? '已取消' : '状态待核对'}${errorMessage ? `（${errorMessage}）` : ''}，将已有产物补录到恢复历史；保留原请求状态。`;
    if (!assetId) return { assetId: '', reason, evidence: '', hint: '没有找到当前产物，请提供资产 ID 与找回依据。' };
    const { asset } = await this.assets.read(assetId);
    const kind = source.provider === 'codex2api' ? (['image-generation', 'image-edit'].includes(source.capabilityId || '') ? 'image' : null)
      : ['cosyvoice3', 'indextts2', 'qwen3tts'].includes(source.provider) ? 'audio' : asset.kind;
    if (asset.canvasId !== source.canvasId || (asset.nodeId && asset.nodeId !== source.nodeId) || source.inputAssetIds.includes(assetId) || kind !== asset.kind) {
      throw new BadRequestException({ code: 'RECOVERY_ASSET_MISMATCH', message: '资产归属、输入引用或媒体类型不符合补录条件' });
    }
    const existing = await this.runs.findOneBy({ idempotencyKey: `recovery:${source.id}:${asset.id}` });
    if (existing?.recovery) return { assetId, reason: existing.recovery.reason, evidence: existing.recovery.evidence, hint: '该产物已补录，显示原记录说明。' };
    const current = node?.data?.lastAssets?.some((item: any) => item.assetId === assetId);
    const providerMatch = !!source.providerRunId && asset.runPromptId === source.providerRunId;
    const note = typeof node?.data?.note === 'string' ? node.data.note : '';
    const noteMatch = note.includes(source.id) && note.includes(assetId);
    if (!current && !providerMatch && !noteMatch) return { assetId, reason, evidence: '', hint: '只能确认资产归属，未找到当前产物、任务 ID 或备注关联，请补充找回依据。' };
    const facts = [`系统查得：原 Run ${source.id}；画布 ${source.canvasId}，节点 ${source.nodeId}；资产 ${assetId} 的文件存在，类型 ${asset.kind}，来源 ${asset.source === 'generated' ? '平台生成资产' : '上传资产'}。`];
    if (asset.originName) facts.push(`资产原文件名：${asset.originName.slice(0, 500)}。`);
    if (providerMatch) facts.push(`资产任务 ID 与原提供方任务 ID 一致：${source.providerRunId}。`);
    if (current) facts.push('该资产是原节点当前显示的产物。');
    if (noteMatch) facts.push(`节点备注（已有记录，非系统核验的上游结果）：${note.slice(0, 2000)}`);
    if (!providerMatch) facts.push('以上为平台现有记录的关联依据，尚未核验是否来自同一次上游生成；由确认者核对后补录。');
    return { assetId, reason, evidence: facts.join('\n'), hint: '已根据平台记录自动填入，请核对后确认；可修改或补充。' };
  }

  async recover(sourceRunId: string, input: RecoverRunInput) {
    const assetId = text(input?.assetId, 'assetId', 100);
    const reason = text(input?.reason, 'reason', 2000);
    const evidence = text(input?.evidence, 'evidence', 4000);
    // Verify actual file presence, not just an asset row. No upload or provider call here.
    await this.assets.read(assetId);
    const register = () => this.runs.manager.transaction(async (manager) => {
      const runs = manager.getRepository(GenerationRun);
      const source = await runs.findOneBy({ id: sourceRunId });
      if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: '原 Run 不存在' });
      if (!source.canvasId || !source.nodeId || source.recovery || !['failed', 'cancelled', 'needs_attention'].includes(source.status)) {
        throw new ConflictException({ code: 'RUN_NOT_RECOVERABLE', message: '仅可补录有画布节点的失败、取消或待核对原 Run' });
      }
      // Authorization and all database writes share the same SQLite transaction.
      const doc = await this.canvas.assertWriteAccess(source.canvasId, input);
      const control = await this.canvas.controlStatus(source.canvasId);
      const holder = control.lease!;
      if (holder.status !== 'active') throw new ConflictException({ code: 'RECOVERY_HANDOFF_PENDING', message: '交接中不能开始新的补录操作' });
      const node = doc.graph.nodes.find((item: any) => item.id === source.nodeId) as any;
      if (!node) throw new BadRequestException({ code: 'NODE_NOT_FOUND', message: '原 Run 的节点已不存在' });
      const asset = await manager.getRepository(Asset).findOneBy({ id: assetId });
      if (!asset || asset.canvasId !== source.canvasId || (asset.nodeId && asset.nodeId !== source.nodeId) || source.inputAssetIds.includes(assetId)) {
        throw new BadRequestException({ code: 'RECOVERY_ASSET_MISMATCH', message: '补录资产必须属于原画布及节点，且不能是原输入参考素材' });
      }
      const expectedKind = source.provider === 'codex2api' ? (['image-generation', 'image-edit'].includes(source.capabilityId || '') ? 'image' : null)
        : ['cosyvoice3', 'indextts2', 'qwen3tts'].includes(source.provider) ? 'audio' : asset.kind;
      if (!expectedKind || expectedKind !== asset.kind) throw new BadRequestException({ code: 'RECOVERY_ASSET_MISMATCH', message: '资产类型与原生成能力不一致；文字补录暂不支持' });

      // One recovered record per original run + asset, independent of browser/session retries.
      const idempotencyKey = `recovery:${source.id}:${asset.id}`;
      const existing = await runs.findOneBy({ idempotencyKey });
      if (existing) {
        if (existing.recovery?.reason !== reason || existing.recovery?.evidence !== evidence) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '该资产已补录，不能通过重试改写恢复证据' });
        return { run: existing, replay: true };
      }
      const others = await runs.findBy({ canvasId: source.canvasId, status: 'succeeded' });
      if (others.some((run) => run.outputAssetIds.includes(assetId))) throw new ConflictException({ code: 'ASSET_ALREADY_RECORDED', message: '该资产已存在于成功产物历史，不能重复归因' });
      const now = Date.now();
      const run = await runs.save(runs.create({
        provider: source.provider, status: 'succeeded', canvasId: source.canvasId, nodeId: source.nodeId,
        shotId: source.shotId, parentRunId: source.id, providerRunId: null,
        capabilityId: source.capabilityId, capabilityVersion: source.capabilityVersion,
        inputSnapshot: source.inputSnapshot, requestSnapshot: null, inputAssetIds: source.inputAssetIds,
        outputAssetIds: [asset.id], outputText: null, outputParts: null,
        actorType: holder.holderType, actorId: holder.holderId, attemptCount: source.attemptCount,
        idempotencyKey, error: null, queuedAt: now, startedAt: null, finishedAt: now,
        recovery: { sourceRunId: source.id, sourceStatus: source.status, reason, evidence, recoveredAt: now, leaseEpoch: holder.epoch },
      }));
      const groups = manager.getRepository(GenerationCandidateGroup);
      let group = await groups.findOneBy({ canvasId: source.canvasId, nodeId: source.nodeId, shotId: source.shotId ?? IsNull() });
      if (!group) {
        group = groups.create({ canvasId: source.canvasId, nodeId: source.nodeId, shotId: source.shotId,
          candidateAssetIds: [], selectedAssetId: null, selectedRunId: null, approvedAssetId: null });
        // Only mark current if this is already the node's displayed output. Never replace it.
        if (node.data?.lastAssets?.some((item: any) => item.assetId === asset.id)) group.selectedAssetId = asset.id;
      }
      group.candidateAssetIds = [...new Set([...group.candidateAssetIds, asset.id])];
      if (group.selectedAssetId === asset.id) group.selectedRunId = run.id;
      await groups.save(group);
      return { run, replay: false };
    });
    // Serialize local recovery transactions (SQLite has a single writer). A
    // simultaneous duplicate waits for the first commit, then replays it.
    const result = this.recoveryQueue.then(register);
    this.recoveryQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function text(value: unknown, field: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} 必须为 1–${limit} 字符的非空文字` });
  return value.trim();
}
