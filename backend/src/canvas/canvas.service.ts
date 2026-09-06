import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssetsService } from '../assets/assets.service';
import { Workflow } from '../workflows/workflow.entity';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasEdge, CanvasGraph, CanvasNode, CanvasOperationLog, CanvasOperationReceipt, emptyCanvasGraph } from './canvas.entity';
import { ACTION_REGISTRY } from './action-registry';

export interface CanvasListItem { id: string; name: string; createdAt: Date; updatedAt: Date; nodeCount: number; assetSize: number; revision: number; }
export interface CreateCanvasDto { name?: string; }
export interface LeaseIdentity { holderType: 'human' | 'agent'; holderId: string; }
export interface LeaseProof { leaseToken: string; leaseEpoch: number; expectedRevision: number; actorType?: 'human' | 'agent'; actorId?: string; idempotencyKey?: string; operationId?: string; }
export interface UpdateCanvasDto extends Partial<LeaseProof> { name?: string; graph?: CanvasGraph; }
export type CanvasOperation =
  | { type: 'replace_graph'; graph: CanvasGraph }
  | { type: 'rename_canvas'; name: string }
  | { type: 'set_brief'; brief: Record<string, unknown> | null }
  | { type: 'create_node'; node: CanvasNode }
  | { type: 'update_node'; nodeId: string; dataPatch: Record<string, unknown> }
  | { type: 'replace_node_data'; nodeId: string; data: Record<string, unknown> }
  | { type: 'move_nodes'; positions: Array<{ nodeId: string; position: { x: number; y: number } }> }
  | { type: 'delete_node'; nodeId: string }
  | { type: 'connect'; edge: CanvasEdge }
  | { type: 'disconnect'; edgeId: string };
export interface OperationBatchDto extends LeaseProof { intent?: string; operations: CanvasOperation[]; }
export interface CheckpointDto extends LeaseProof { name: string; description?: string; }

const DEFAULT_CANVAS_NAME = '未命名画布';
const LEASE_TTL_MS = 45_000;
const SERVER_INSTANCE_ID = randomUUID();

@Injectable()
export class CanvasService implements OnModuleInit {
  private readonly logger = new Logger(CanvasService.name);
  constructor(
    @InjectRepository(CanvasDoc) private readonly repo: Repository<CanvasDoc>,
    @InjectRepository(CanvasControlLease) private readonly leases: Repository<CanvasControlLease>,
    @InjectRepository(CanvasOperationReceipt) private readonly receipts: Repository<CanvasOperationReceipt>,
    @InjectRepository(CanvasOperationLog) private readonly logs: Repository<CanvasOperationLog>,
    @InjectRepository(CanvasCheckpoint) private readonly checkpoints: Repository<CanvasCheckpoint>,
    @InjectRepository(CanvasAssetGcJob) private readonly gcJobs: Repository<CanvasAssetGcJob>,
    private readonly assets: AssetsService,
  ) {}

  onModuleInit() { return this.processPendingGc(); }

  actions() { return { registryVersion: 1, actions: ACTION_REGISTRY }; }
  async list(): Promise<CanvasListItem[]> { const docs = await this.repo.find({ order: { updatedAt: 'DESC' } }); const sizes = await this.assets.getCanvasAssetSizes(); return docs.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt, revision: d.revision ?? 0, nodeCount: Array.isArray(d.graph?.nodes) ? d.graph.nodes.length : 0, assetSize: sizes[d.id] ?? 0 })); }
  async create(dto: CreateCanvasDto): Promise<CanvasDoc> { const doc = this.repo.create({ name: (dto.name ?? '').trim() || DEFAULT_CANVAS_NAME, graph: emptyCanvasGraph(), revision: 0, schemaVersion: 1, brief: null, activeCheckpointId: null, lastHandoffId: null, updatedByType: null, updatedById: null }); const saved = await this.repo.save(doc); await this.assets.ensureCanvasPartition(saved.id); return saved; }
  async findOne(id: string): Promise<CanvasDoc> { const doc = await this.repo.findOne({ where: { id } }); if (!doc) throw new NotFoundException({ code: 'CANVAS_NOT_FOUND', message: `画布 ${id} 不存在` }); return doc; }
  async agentView(id: string) { const canvas = await this.findOne(id); return { canvas, control: await this.controlStatus(id), supportedOperations: ['replace_graph', 'rename_canvas', 'set_brief', 'create_node', 'update_node', 'move_nodes', 'delete_node', 'connect', 'disconnect'], actionsUrl: '/api/actions', operationLogUrl: `/api/canvas/${id}/operation-log`, checkpointsUrl: `/api/canvas/${id}/checkpoints` }; }
  async controlStatus(id: string) { await this.findOne(id); const lease = await this.getNormalizedLease(id); if (!lease) return { status: 'available', lease: null }; return { status: lease.status, lease: this.publicLease(lease) }; }
  async assertWriteAccess(id: string, proof: Partial<LeaseProof>) { await this.requireLease(id, proof); const canvas = await this.findOne(id); if (proof.expectedRevision !== (canvas.revision ?? 0)) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: proof.expectedRevision, currentRevision: canvas.revision ?? 0 }); return canvas; }
  async assertLeaseHolder(id: string, proof: Partial<LeaseProof> & LeaseIdentity) { const lease = await this.requireLease(id, proof); if (proof.actorType !== lease.holderType || proof.actorId !== lease.holderId) this.fail(403, 'OPERATION_NOT_ALLOWED', '交接操作者必须与当前租约持有者一致'); return lease; }

  async acquire(id: string, identity: LeaseIdentity) {
    this.validateIdentity(identity); const canvas = await this.findOne(id); let lease = await this.getNormalizedLease(id);
    if (lease && ['active', 'handoff_pending'].includes(lease.status)) { if (lease.holderType !== identity.holderType || lease.holderId !== identity.holderId) this.fail(423, 'CANVAS_LOCKED', '画布正由另一位写入者控制', { lease: this.publicLease(lease) }); this.fail(409, 'LEASE_ALREADY_HELD', '当前写入者已持有租约，请续租', { lease: this.publicLease(lease) }); }
    const token = randomBytes(32).toString('base64url'); const now = new Date(); lease = this.leases.create({ ...(lease ?? {}), canvasId: id, epoch: (lease?.epoch ?? 0) + 1, holderType: identity.holderType, holderId: identity.holderId, tokenHash: this.hash(token), status: 'active', handoffRequestedByType: null, handoffRequestedById: null, acquiredAt: now, lastHeartbeatAt: now, expiresAt: new Date(now.getTime() + LEASE_TTL_MS), serverInstanceId: SERVER_INSTANCE_ID }); await this.leases.save(lease); return { ...this.publicLease(lease), leaseToken: token, ttlMs: LEASE_TTL_MS, revision: canvas.revision ?? 0 };
  }
  async renew(id: string, proof: Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>) { const lease = await this.requireLease(id, proof); lease.lastHeartbeatAt = new Date(); lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS); await this.leases.save(lease); return { ...this.publicLease(lease), leaseToken: proof.leaseToken, ttlMs: LEASE_TTL_MS }; }
  async release(id: string, proof: Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>) { const lease = await this.requireLease(id, proof); const canvas = await this.findOne(id); lease.status = 'revoked'; lease.expiresAt = new Date(); await this.leases.save(lease); return { released: true, epoch: lease.epoch, revision: canvas.revision ?? 0 }; }
  async attachHandoff(id: string, handoffId: string, proof: Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>) { await this.requireLease(id, proof); await this.repo.update(id, { lastHandoffId: handoffId }); }
  async requestHandoff(id: string, identity: LeaseIdentity) { this.validateIdentity(identity); await this.findOne(id); const lease = await this.getNormalizedLease(id); if (!lease || !['active','handoff_pending'].includes(lease.status)) return { status: 'available', lease: null }; if (lease.holderType === identity.holderType && lease.holderId === identity.holderId) throw new BadRequestException({ code: 'HANDOFF_SELF_REQUEST', message: '当前控制者无需向自己请求交接' }); lease.status = 'handoff_pending'; lease.handoffRequestedByType = identity.holderType; lease.handoffRequestedById = identity.holderId; await this.leases.save(lease); return { status: lease.status, lease: this.publicLease(lease) }; }
  async forceTakeover(id: string, dto: LeaseIdentity & { reason: string }) { this.validateIdentity(dto); if (dto.holderType !== 'human') this.fail(403, 'OPERATION_NOT_ALLOWED', '只有人工可以故障强制接管'); if (!dto.reason?.trim()) throw new BadRequestException({ code: 'TAKEOVER_REASON_REQUIRED', message: '强制接管必须记录原因' }); const prior = await this.getNormalizedLease(id); if (prior) { prior.status = 'revoked'; prior.lastTakeoverReason = dto.reason.trim(); await this.leases.save(prior); } const acquired = await this.acquire(id, dto); const next = await this.leases.findOne({ where: { canvasId: id } }); if (next) { next.lastTakeoverReason = dto.reason.trim(); await this.leases.save(next); } return acquired; }

  async update(id: string, dto: UpdateCanvasDto): Promise<CanvasDoc> { if (dto.graph === undefined && dto.name === undefined) return this.findOne(id); const operations: OperationBatchDto['operations'] = []; if (dto.name !== undefined) operations.push({ type: 'rename_canvas', name: dto.name }); if (dto.graph !== undefined) operations.push({ type: 'replace_graph', graph: dto.graph }); const proof = dto as LeaseProof; const result = await this.applyOperations(id, { ...proof, idempotencyKey: proof.idempotencyKey ?? proof.operationId ?? randomUUID(), operations }); return result.canvas; }
  async applyOperations(id: string, dto: OperationBatchDto): Promise<{ canvas: CanvasDoc; baseRevision: number; resultRevision: number; replayed: boolean }> {
    if (!dto.idempotencyKey && !dto.operationId) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '需要 idempotencyKey 或 operationId' }); if (!Array.isArray(dto.operations) || dto.operations.length === 0) throw new BadRequestException({ code: 'OPERATIONS_REQUIRED', message: 'operations 不能为空' });
    const key = dto.idempotencyKey ?? dto.operationId!;
    const requestHash = this.hash(JSON.stringify({ expectedRevision: dto.expectedRevision, operations: dto.operations }));
    const lease = await this.requireLease(id, dto);
    const result = await this.repo.manager.transaction(async (manager) => {
      const canvasRepo = manager.getRepository(CanvasDoc);
      const receiptRepo = manager.getRepository(CanvasOperationReceipt);
      const logRepo = manager.getRepository(CanvasOperationLog);
      const gcRepo = manager.getRepository(CanvasAssetGcJob);
      const existing = await receiptRepo.findOne({ where: { canvasId: id, idempotencyKey: key } });
      if (existing) {
        if (existing.requestHash !== requestHash) this.fail(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同请求');
        return { ...(existing.response as any), replayed: true };
      }
      const doc = await canvasRepo.findOne({ where: { id } });
      if (!doc) throw new NotFoundException({ code: 'CANVAS_NOT_FOUND', message: `画布 ${id} 不存在` });
      const baseRevision = doc.revision ?? 0;
      if (dto.expectedRevision !== baseRevision) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: dto.expectedRevision, currentRevision: baseRevision });
      const draft = cloneState(doc);
      const inverseOperations: CanvasOperation[] = [];
      const deletedGeneratedNodeIds: string[] = [];
      for (const op of dto.operations) applyCanvasOperation(draft, op, inverseOperations, deletedGeneratedNodeIds);
      validateGraph(draft.graph);
      await validateWorkflowHandles(draft.graph, manager.getRepository(Workflow));
      doc.name = draft.name; doc.graph = draft.graph; doc.brief = draft.brief;
      doc.revision = baseRevision + 1; doc.updatedByType = dto.actorType ?? lease.holderType; doc.updatedById = dto.actorId ?? lease.holderId;
      const updated = await canvasRepo.update({ id, revision: baseRevision }, { name: doc.name, graph: doc.graph, brief: doc.brief, revision: doc.revision, updatedByType: doc.updatedByType, updatedById: doc.updatedById } as any);
      if (updated.affected !== 1) this.fail(409, 'REVISION_CONFLICT', '画布被并发修改，请重新读取后重试');
      const canvas = await canvasRepo.findOneOrFail({ where: { id } });
      const response = { canvas, baseRevision, resultRevision: canvas.revision };
      await receiptRepo.save(receiptRepo.create({ canvasId: id, idempotencyKey: key, requestHash, resultRevision: canvas.revision, response }));
      await logRepo.save(logRepo.create({ canvasId: id, baseRevision, resultRevision: canvas.revision, leaseEpoch: lease.epoch, actorType: doc.updatedByType!, actorId: doc.updatedById!, intent: dto.intent?.trim() || null, operations: dto.operations as any, inverseOperations: inverseOperations.reverse() as any, idempotencyKey: key, undoneByLogId: null }));
      if (deletedGeneratedNodeIds.length) await gcRepo.save(deletedGeneratedNodeIds.map((nodeId) => gcRepo.create({ canvasId: id, nodeId, attempts: 0, lastError: null, lastAttemptAt: null })));
      return { ...response, replayed: false, deletedGeneratedNodeIds } as any;
    });
    try { await this.processPendingGc(id); }
    catch (error) { this.logger.warn(`画布 ${id} 已提交，但垃圾回收队列处理失败：${error instanceof Error ? error.message : error}`); }
    delete (result as any).deletedGeneratedNodeIds;
    return result;
  }

  private async processPendingGc(canvasId?: string) {
    const jobs = await this.gcJobs.find(canvasId ? { where: { canvasId }, order: { createdAt: 'ASC' } } : { order: { createdAt: 'ASC' } });
    for (const job of jobs) {
      const protectedByCheckpoint = (await this.checkpoints.find({ where: { canvasId: job.canvasId } })).some((checkpoint) => checkpoint.graph.nodes.some((node) => node.id === job.nodeId));
      if (protectedByCheckpoint) continue;
      try { await this.assets.deleteGeneratedByNode(job.canvasId, job.nodeId); await this.gcJobs.delete(job.id); }
      catch (error) { job.attempts += 1; job.lastAttemptAt = new Date(); job.lastError = error instanceof Error ? error.message : String(error); await this.gcJobs.save(job); this.logger.warn(`画布 ${job.canvasId} 节点 ${job.nodeId} 资产垃圾回收失败（第 ${job.attempts} 次）：${job.lastError}`); }
    }
  }

  async operationLog(id: string, limit = 50) { await this.findOne(id); return this.logs.find({ where: { canvasId: id }, order: { resultRevision: 'DESC' }, take: Math.min(Math.max(limit, 1), 200) }); }

  async createCheckpoint(id: string, dto: CheckpointDto) {
    const lease = await this.requireLease(id, dto);
    const canvas = await this.findOne(id);
    if (dto.expectedRevision !== canvas.revision) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { currentRevision: canvas.revision });
    const name = dto.name?.trim(); if (!name) throw new BadRequestException({ code: 'INVALID_CHECKPOINT_NAME', message: '恢复点名称不能为空' });
    const checkpoint = await this.checkpoints.save(this.checkpoints.create({ canvasId: id, name, description: dto.description?.trim() || null, revision: canvas.revision, canvasName: canvas.name, graph: canvas.graph, brief: canvas.brief, createdByType: dto.actorType ?? lease.holderType, createdById: dto.actorId ?? lease.holderId }));
    return checkpoint;
  }
  async listCheckpoints(id: string) { await this.findOne(id); return this.checkpoints.find({ where: { canvasId: id }, order: { createdAt: 'DESC' } }); }
  async restoreCheckpoint(id: string, checkpointId: string, dto: LeaseProof) {
    const checkpoint = await this.checkpoints.findOne({ where: { id: checkpointId, canvasId: id } });
    if (!checkpoint) throw new NotFoundException({ code: 'CHECKPOINT_NOT_FOUND', message: '恢复点不存在' });
    return this.applyOperations(id, { ...dto, idempotencyKey: dto.idempotencyKey ?? dto.operationId!, intent: `restore checkpoint ${checkpoint.name}`, operations: [{ type: 'rename_canvas', name: checkpoint.canvasName }, { type: 'replace_graph', graph: checkpoint.graph }, { type: 'set_brief', brief: checkpoint.brief }] });
  }
  async undoOperation(id: string, logId: string, dto: LeaseProof) {
    const log = await this.logs.findOne({ where: { id: logId, canvasId: id } });
    if (!log) throw new NotFoundException({ code: 'OPERATION_LOG_NOT_FOUND', message: '操作批次不存在' });
    if (log.undoneByLogId) this.fail(409, 'OPERATION_ALREADY_UNDONE', '该操作批次已经撤销');
    if ((log.inverseOperations as CanvasOperation[]).some((operation) => operation.type === 'create_node' && Array.isArray(operation.node.data.lastAssets) && operation.node.data.lastAssets.length > 0)) this.fail(409, 'OPERATION_NOT_REVERSIBLE', '该批次删除了带产出资产的节点，不能日常撤销；请恢复删除前的 Checkpoint');
    if (dto.expectedRevision !== log.resultRevision) this.fail(409, 'UNDO_PRECONDITION_FAILED', '撤销后已有其他修改；为避免覆盖后续修改，拒绝撤销', { operationRevision: log.resultRevision, currentRevision: dto.expectedRevision });
    const result = await this.applyOperations(id, { ...dto, idempotencyKey: dto.idempotencyKey ?? dto.operationId!, intent: `undo ${log.id}`, operations: log.inverseOperations as CanvasOperation[] });
    const undoLog = await this.logs.findOne({ where: { canvasId: id, resultRevision: result.resultRevision } });
    log.undoneByLogId = undoLog?.id ?? 'completed'; await this.logs.save(log);
    return result;
  }
  async remove(id: string, proof?: Partial<LeaseProof>): Promise<void> { await this.requireLease(id, proof ?? {}); const doc = await this.findOne(id); if (proof?.expectedRevision !== (doc.revision ?? 0)) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: proof?.expectedRevision, currentRevision: doc.revision ?? 0 }); await this.assets.deleteCanvas(id); await this.repo.remove(doc); }

  private async requireLease(id: string, proof: Partial<Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>>) { const lease = await this.getNormalizedLease(id); if (!lease || ['expired','revoked'].includes(lease.status)) this.fail(410, 'LEASE_EXPIRED', '画布写入租约不存在或已过期'); if (proof.leaseEpoch !== lease.epoch) this.fail(409, 'STALE_LEASE', '租约 epoch 已变化', { currentEpoch: lease.epoch }); if (!proof.leaseToken || this.hash(proof.leaseToken) !== lease.tokenHash) this.fail(403, 'OPERATION_NOT_ALLOWED', '租约令牌无效'); return lease; }
  private async getNormalizedLease(canvasId: string) { const lease = await this.leases.findOne({ where: { canvasId } }); if (lease && ['active','handoff_pending'].includes(lease.status) && ((lease.serverInstanceId && lease.serverInstanceId !== SERVER_INSTANCE_ID) || new Date(lease.expiresAt).getTime() <= Date.now())) { lease.status = 'expired'; await this.leases.save(lease); } return lease; }
  private publicLease(l: CanvasControlLease) { return { canvasId: l.canvasId, epoch: l.epoch, holderType: l.holderType, holderId: l.holderId, status: l.status, acquiredAt: l.acquiredAt, lastHeartbeatAt: l.lastHeartbeatAt, expiresAt: l.expiresAt, handoffRequestedByType: l.handoffRequestedByType, handoffRequestedById: l.handoffRequestedById, lastTakeoverReason: l.lastTakeoverReason }; }
  private validateIdentity(v: LeaseIdentity) { if (!v || !['human','agent'].includes(v.holderType) || !v.holderId?.trim()) throw new BadRequestException({ code: 'INVALID_HOLDER', message: 'holderType 和 holderId 必填' }); }
  private hash(v: string) { return createHash('sha256').update(v).digest('hex'); }
  private fail(status: number, code: string, message: string, details?: unknown): never { throw new HttpException({ statusCode: status, code, message, details }, status); }
}

function cloneState(doc: CanvasDoc): Pick<CanvasDoc, 'name' | 'graph' | 'brief'> { return JSON.parse(JSON.stringify({ name: doc.name, graph: doc.graph, brief: doc.brief })); }
function bad(code: string, message: string, details?: unknown): never { throw new BadRequestException({ code, message, details }); }
function validId(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function validateNode(node: CanvasNode) {
  if (!node || !validId(node.id)) bad('INVALID_NODE', '节点 id 不合法');
  if (!['txt2img', 'result', 'codex-capability'].includes(node.type)) bad('UNSUPPORTED_NODE_TYPE', `不支持节点类型 ${node.type}`);
  if (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) bad('INVALID_NODE_POSITION', `节点 ${node.id} 坐标不合法`);
  if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) bad('INVALID_NODE_DATA', `节点 ${node.id} data 不合法`);
  if (node.type === 'txt2img' && (!validId(node.data.workflowId) || (node.data.formValues != null && (typeof node.data.formValues !== 'object' || Array.isArray(node.data.formValues))))) bad('INVALID_NODE_DATA', 'txt2img 节点需要 workflowId，formValues 必须为对象');
  if (node.type === 'result' && node.data.kind != null && !['image', 'video', 'audio', 'text'].includes(String(node.data.kind))) bad('INVALID_NODE_DATA', 'result.kind 不合法');
  if (node.type === 'codex-capability' && (!['text', 'image', 'edit', 'analyze'].includes(String(node.data.capability)) || typeof node.data.prompt !== 'string' || typeof node.data.model !== 'string')) bad('INVALID_NODE_DATA', 'AI 能力节点字段不合法');
}
function handleKind(handle: string, source: boolean): string | null {
  if (source && (handle === 'text-positive-source' || handle === 'text-negative-source')) return 'text';
  const suffix = source ? '-source' : '-target';
  if (handle.endsWith(suffix)) return handle.slice(0, -suffix.length);
  if (!source && handle.startsWith('input:')) return handle.startsWith('input:text:') ? 'text' : handle.startsWith('input:video:') ? 'video' : handle.startsWith('input:audio:') ? 'audio' : 'image';
  return null;
}
function validateGraph(graph: CanvasGraph) {
  if (!graph || typeof graph !== 'object' || typeof graph.version !== 'number' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) bad('INVALID_GRAPH', 'graph 结构不合法');
  const nodes = new Map<string, CanvasNode>();
  for (const node of graph.nodes) { validateNode(node); if (nodes.has(node.id)) bad('DUPLICATE_NODE_ID', `节点 id 重复: ${node.id}`); nodes.set(node.id, node); }
  const edgeIds = new Set<string>(); const inputs = new Set<string>(); const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || !validId(edge.source) || !validId(edge.target) || !validId(edge.sourceHandle) || !validId(edge.targetHandle)) bad('INVALID_EDGE', '连线字段不合法');
    if (edgeIds.has(edge.id)) bad('DUPLICATE_EDGE_ID', `连线 id 重复: ${edge.id}`); edgeIds.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) bad('EDGE_NODE_NOT_FOUND', `连线 ${edge.id} 引用了不存在的节点`);
    if (edge.source === edge.target) bad('CYCLE_NOT_ALLOWED', '禁止节点连接自身');
    const sourceKind = handleKind(edge.sourceHandle, true), targetKind = handleKind(edge.targetHandle, false);
    if (!sourceKind || !targetKind) bad('HANDLE_NOT_FOUND', `连线 ${edge.id} 句柄不合法`);
    const sourceNode = nodes.get(edge.source)!, targetNode = nodes.get(edge.target)!;
    const allowedSource = sourceNode.type === 'txt2img' ? ['image', 'video'] : sourceNode.type === 'result' ? [String(sourceNode.data.kind ?? 'image')] : ['text', 'analyze'].includes(String(sourceNode.data.capability)) ? ['text'] : ['image'];
    if (!allowedSource.includes(sourceKind)) bad('HANDLE_NOT_FOUND', `源节点 ${edge.source} 不存在 ${edge.sourceHandle}`);
    if (edge.targetHandle.endsWith('-target')) {
      const acceptsTarget = targetNode.type === 'result'
        ? String(targetNode.data.kind ?? 'image') === targetKind
        : targetNode.type === 'codex-capability'
          ? targetKind === 'text' || (targetKind === 'image' && ['edit', 'analyze'].includes(String(targetNode.data.capability)))
          : false;
      if (!acceptsTarget) bad('HANDLE_NOT_FOUND', `目标节点 ${edge.target} 不存在 ${edge.targetHandle}`);
    }
    if (edge.targetHandle.startsWith('input:')) {
      if (targetNode.type !== 'txt2img') bad('HANDLE_NOT_FOUND', `目标节点 ${edge.target} 不接受工作流输入句柄`);
      const parts = edge.targetHandle.split(':');
      if (parts.length < 3 || !parts.at(-1)) bad('HANDLE_NOT_FOUND', `工作流输入句柄 ${edge.targetHandle} 格式不合法`);
    }
    if (sourceKind !== targetKind) bad('MEDIA_TYPE_MISMATCH', `${sourceKind} 不能连接到 ${targetKind}`);
    const inputKey = `${edge.target}:${edge.targetHandle}`; if (inputs.has(inputKey)) bad('MAX_INCOMING_EXCEEDED', '同一输入端口最多一条入线'); inputs.add(inputKey);
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) bad('CYCLE_NOT_ALLOWED', '画布不允许环路'); if (visited.has(id)) return; visiting.add(id); for (const next of adjacency.get(id) ?? []) visit(next); visiting.delete(id); visited.add(id); };
  for (const id of nodes.keys()) visit(id);
}
function applyCanvasOperation(draft: Pick<CanvasDoc, 'name' | 'graph' | 'brief'>, op: CanvasOperation, inverse: CanvasOperation[], deletedGeneratedNodeIds: string[]) {
  if (op.type === 'replace_graph') { validateGraph(op.graph); inverse.push({ type: 'replace_graph', graph: draft.graph }); draft.graph = JSON.parse(JSON.stringify(op.graph)); return; }
  if (op.type === 'rename_canvas') { const name = op.name?.trim(); if (!name) bad('INVALID_CANVAS_NAME', '画布名不能为空'); inverse.push({ type: 'rename_canvas', name: draft.name }); draft.name = name; return; }
  if (op.type === 'set_brief') { inverse.push({ type: 'set_brief', brief: draft.brief }); draft.brief = op.brief; return; }
  if (op.type === 'create_node') { if (draft.graph.nodes.some((n) => n.id === op.node.id)) bad('DUPLICATE_NODE_ID', `节点 id 重复: ${op.node.id}`); validateNode(op.node); draft.graph.nodes.push(JSON.parse(JSON.stringify(op.node))); inverse.push({ type: 'delete_node', nodeId: op.node.id }); return; }
  const nodeIndex = 'nodeId' in op ? draft.graph.nodes.findIndex((n) => n.id === op.nodeId) : -1;
  if ('nodeId' in op && nodeIndex < 0) bad('NODE_NOT_FOUND', `节点 ${op.nodeId} 不存在`);
  if (op.type === 'update_node') { const node = draft.graph.nodes[nodeIndex]; const prior = JSON.parse(JSON.stringify(node.data)); node.data = { ...node.data, ...op.dataPatch }; validateNode(node); inverse.push({ type: 'replace_node_data', nodeId: op.nodeId, data: prior }); return; }
  if (op.type === 'replace_node_data') { const node = draft.graph.nodes[nodeIndex]; const prior = JSON.parse(JSON.stringify(node.data)); node.data = JSON.parse(JSON.stringify(op.data)); validateNode(node); inverse.push({ type: 'replace_node_data', nodeId: op.nodeId, data: prior }); return; }
  if (op.type === 'move_nodes') { const prior = op.positions.map((item) => { const node = draft.graph.nodes.find((n) => n.id === item.nodeId); if (!node) bad('NODE_NOT_FOUND', `节点 ${item.nodeId} 不存在`); if (!Number.isFinite(item.position?.x) || !Number.isFinite(item.position?.y)) bad('INVALID_NODE_POSITION', '节点坐标不合法'); const before = { nodeId: item.nodeId, position: node.position }; node.position = item.position; return before; }); inverse.push({ type: 'move_nodes', positions: prior }); return; }
  if (op.type === 'delete_node') { const node = draft.graph.nodes[nodeIndex]; const edges = draft.graph.edges.filter((e) => e.source === op.nodeId || e.target === op.nodeId); draft.graph.nodes.splice(nodeIndex, 1); draft.graph.edges = draft.graph.edges.filter((e) => e.source !== op.nodeId && e.target !== op.nodeId); inverse.push({ type: 'create_node', node }, ...edges.map((edge) => ({ type: 'connect', edge } as CanvasOperation))); if (node.type === 'txt2img' || node.type === 'codex-capability') deletedGeneratedNodeIds.push(node.id); return; }
  if (op.type === 'connect') { if (draft.graph.edges.some((e) => e.id === op.edge.id)) bad('DUPLICATE_EDGE_ID', `连线 id 重复: ${op.edge.id}`); draft.graph.edges.push(JSON.parse(JSON.stringify(op.edge))); validateGraph(draft.graph); inverse.push({ type: 'disconnect', edgeId: op.edge.id }); return; }
  if (op.type === 'disconnect') { const index = draft.graph.edges.findIndex((e) => e.id === op.edgeId); if (index < 0) bad('EDGE_NOT_FOUND', `连线 ${op.edgeId} 不存在`); const [edge] = draft.graph.edges.splice(index, 1); inverse.push({ type: 'connect', edge }); return; }
  bad('UNKNOWN_OPERATION', `不支持的操作 ${(op as any).type}`);
}

async function validateWorkflowHandles(graph: CanvasGraph, workflows: Repository<Workflow>) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const workflowIds = [...new Set(graph.nodes.filter((node) => node.type === 'txt2img').map((node) => String(node.data.workflowId)))];
  if (!workflowIds.length) return;
  const configured = new Map((await workflows.findByIds(workflowIds)).map((workflow) => [workflow.id, workflow]));
  for (const edge of graph.edges.filter((item) => item.targetHandle.startsWith('input:'))) {
    const node = nodes.get(edge.target)!; const workflow = configured.get(String(node.data.workflowId));
    // 已删除的工作流允许作为历史节点继续存在；若工作流存在，其端口必须精确匹配 inputConfig。
    if (!workflow) continue;
    const exists = workflow.inputConfig?.fields?.some((field) => edge.targetHandle === (field.kind === 'image' ? `input:${field.nodeId}:${field.param}` : `input:${field.kind}:${field.nodeId}:${field.param}`));
    if (!exists) bad('HANDLE_NOT_FOUND', `工作流 ${workflow.id} 未声明输入端口 ${edge.targetHandle}`);
  }
}
