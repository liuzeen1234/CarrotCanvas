import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssetsService } from '../assets/assets.service';
import { CanvasControlLease, CanvasDoc, CanvasGraph, CanvasOperationReceipt, emptyCanvasGraph } from './canvas.entity';
import { ACTION_REGISTRY } from './action-registry';

export interface CanvasListItem { id: string; name: string; createdAt: Date; updatedAt: Date; nodeCount: number; assetSize: number; revision: number; }
export interface CreateCanvasDto { name?: string; }
export interface LeaseIdentity { holderType: 'human' | 'agent'; holderId: string; }
export interface LeaseProof { leaseToken: string; leaseEpoch: number; expectedRevision: number; actorType?: 'human' | 'agent'; actorId?: string; idempotencyKey?: string; operationId?: string; }
export interface UpdateCanvasDto extends Partial<LeaseProof> { name?: string; graph?: CanvasGraph; }
export interface OperationBatchDto extends LeaseProof { intent?: string; operations: Array<{ type: 'replace_graph'; graph: CanvasGraph } | { type: 'rename_canvas'; name: string } | { type: 'set_brief'; brief: Record<string, unknown> | null }>; }

const DEFAULT_CANVAS_NAME = '未命名画布';
const LEASE_TTL_MS = 45_000;
const SERVER_INSTANCE_ID = randomUUID();

@Injectable()
export class CanvasService {
  constructor(
    @InjectRepository(CanvasDoc) private readonly repo: Repository<CanvasDoc>,
    @InjectRepository(CanvasControlLease) private readonly leases: Repository<CanvasControlLease>,
    @InjectRepository(CanvasOperationReceipt) private readonly receipts: Repository<CanvasOperationReceipt>,
    private readonly assets: AssetsService,
  ) {}

  actions() { return { registryVersion: 1, actions: ACTION_REGISTRY }; }
  async list(): Promise<CanvasListItem[]> { const docs = await this.repo.find({ order: { updatedAt: 'DESC' } }); const sizes = await this.assets.getCanvasAssetSizes(); return docs.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt, revision: d.revision ?? 0, nodeCount: Array.isArray(d.graph?.nodes) ? d.graph.nodes.length : 0, assetSize: sizes[d.id] ?? 0 })); }
  async create(dto: CreateCanvasDto): Promise<CanvasDoc> { const doc = this.repo.create({ name: (dto.name ?? '').trim() || DEFAULT_CANVAS_NAME, graph: emptyCanvasGraph(), revision: 0, schemaVersion: 1, brief: null, activeCheckpointId: null, lastHandoffId: null, updatedByType: null, updatedById: null }); const saved = await this.repo.save(doc); await this.assets.ensureCanvasPartition(saved.id); return saved; }
  async findOne(id: string): Promise<CanvasDoc> { const doc = await this.repo.findOne({ where: { id } }); if (!doc) throw new NotFoundException({ code: 'CANVAS_NOT_FOUND', message: `画布 ${id} 不存在` }); return doc; }
  async agentView(id: string) { const canvas = await this.findOne(id); return { canvas, control: await this.controlStatus(id), supportedOperations: ['replace_graph', 'rename_canvas', 'set_brief'], actionsUrl: '/api/actions' }; }
  async controlStatus(id: string) { await this.findOne(id); const lease = await this.getNormalizedLease(id); if (!lease) return { status: 'available', lease: null }; return { status: lease.status, lease: this.publicLease(lease) }; }
  async assertWriteAccess(id: string, proof: Partial<LeaseProof>) { await this.requireLease(id, proof); const canvas = await this.findOne(id); if (proof.expectedRevision !== (canvas.revision ?? 0)) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: proof.expectedRevision, currentRevision: canvas.revision ?? 0 }); return canvas; }

  async acquire(id: string, identity: LeaseIdentity) {
    this.validateIdentity(identity); const canvas = await this.findOne(id); let lease = await this.getNormalizedLease(id);
    if (lease && ['active', 'handoff_pending'].includes(lease.status)) { if (lease.holderType !== identity.holderType || lease.holderId !== identity.holderId) this.fail(423, 'CANVAS_LOCKED', '画布正由另一位写入者控制', { lease: this.publicLease(lease) }); this.fail(409, 'LEASE_ALREADY_HELD', '当前写入者已持有租约，请续租', { lease: this.publicLease(lease) }); }
    const token = randomBytes(32).toString('base64url'); const now = new Date(); lease = this.leases.create({ ...(lease ?? {}), canvasId: id, epoch: (lease?.epoch ?? 0) + 1, holderType: identity.holderType, holderId: identity.holderId, tokenHash: this.hash(token), status: 'active', handoffRequestedByType: null, handoffRequestedById: null, acquiredAt: now, lastHeartbeatAt: now, expiresAt: new Date(now.getTime() + LEASE_TTL_MS), serverInstanceId: SERVER_INSTANCE_ID }); await this.leases.save(lease); return { ...this.publicLease(lease), leaseToken: token, ttlMs: LEASE_TTL_MS, revision: canvas.revision ?? 0 };
  }
  async renew(id: string, proof: Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>) { const lease = await this.requireLease(id, proof); lease.lastHeartbeatAt = new Date(); lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS); await this.leases.save(lease); return { ...this.publicLease(lease), leaseToken: proof.leaseToken, ttlMs: LEASE_TTL_MS }; }
  async release(id: string, proof: Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>) { const lease = await this.requireLease(id, proof); const canvas = await this.findOne(id); lease.status = 'revoked'; lease.expiresAt = new Date(); await this.leases.save(lease); return { released: true, epoch: lease.epoch, revision: canvas.revision ?? 0 }; }
  async requestHandoff(id: string, identity: LeaseIdentity) { this.validateIdentity(identity); await this.findOne(id); const lease = await this.getNormalizedLease(id); if (!lease || !['active','handoff_pending'].includes(lease.status)) return { status: 'available', lease: null }; if (lease.holderType === identity.holderType && lease.holderId === identity.holderId) throw new BadRequestException({ code: 'HANDOFF_SELF_REQUEST', message: '当前控制者无需向自己请求交接' }); lease.status = 'handoff_pending'; lease.handoffRequestedByType = identity.holderType; lease.handoffRequestedById = identity.holderId; await this.leases.save(lease); return { status: lease.status, lease: this.publicLease(lease) }; }
  async forceTakeover(id: string, dto: LeaseIdentity & { reason: string }) { this.validateIdentity(dto); if (dto.holderType !== 'human') this.fail(403, 'OPERATION_NOT_ALLOWED', '只有人工可以故障强制接管'); if (!dto.reason?.trim()) throw new BadRequestException({ code: 'TAKEOVER_REASON_REQUIRED', message: '强制接管必须记录原因' }); const prior = await this.getNormalizedLease(id); if (prior) { prior.status = 'revoked'; prior.lastTakeoverReason = dto.reason.trim(); await this.leases.save(prior); } const acquired = await this.acquire(id, dto); const next = await this.leases.findOne({ where: { canvasId: id } }); if (next) { next.lastTakeoverReason = dto.reason.trim(); await this.leases.save(next); } return acquired; }

  async update(id: string, dto: UpdateCanvasDto): Promise<CanvasDoc> { if (dto.graph === undefined && dto.name === undefined) return this.findOne(id); const operations: OperationBatchDto['operations'] = []; if (dto.name !== undefined) operations.push({ type: 'rename_canvas', name: dto.name }); if (dto.graph !== undefined) operations.push({ type: 'replace_graph', graph: dto.graph }); const proof = dto as LeaseProof; const result = await this.applyOperations(id, { ...proof, idempotencyKey: proof.idempotencyKey ?? proof.operationId ?? randomUUID(), operations }); return result.canvas; }
  async applyOperations(id: string, dto: OperationBatchDto): Promise<{ canvas: CanvasDoc; baseRevision: number; resultRevision: number; replayed: boolean }> {
    if (!dto.idempotencyKey && !dto.operationId) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '需要 idempotencyKey 或 operationId' }); if (!Array.isArray(dto.operations) || dto.operations.length === 0) throw new BadRequestException({ code: 'OPERATIONS_REQUIRED', message: 'operations 不能为空' });
    const key = dto.idempotencyKey ?? dto.operationId!;
    const requestHash = this.hash(JSON.stringify({ expectedRevision: dto.expectedRevision, operations: dto.operations }));
    const lease = await this.requireLease(id, dto);
    return this.repo.manager.transaction(async (manager) => {
      const canvasRepo = manager.getRepository(CanvasDoc);
      const receiptRepo = manager.getRepository(CanvasOperationReceipt);
      const existing = await receiptRepo.findOne({ where: { canvasId: id, idempotencyKey: key } });
      if (existing) {
        if (existing.requestHash !== requestHash) this.fail(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同请求');
        return { ...(existing.response as any), replayed: true };
      }
      const doc = await canvasRepo.findOne({ where: { id } });
      if (!doc) throw new NotFoundException({ code: 'CANVAS_NOT_FOUND', message: `画布 ${id} 不存在` });
      const baseRevision = doc.revision ?? 0;
      if (dto.expectedRevision !== baseRevision) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: dto.expectedRevision, currentRevision: baseRevision });
      for (const op of dto.operations) {
        if (op.type === 'replace_graph') { if (!isValidGraph(op.graph)) throw new BadRequestException({ code: 'INVALID_GRAPH', message: 'graph 结构不合法' }); doc.graph = op.graph; }
        else if (op.type === 'rename_canvas') { const name = op.name?.trim(); if (!name) throw new BadRequestException({ code: 'INVALID_CANVAS_NAME', message: '画布名不能为空' }); doc.name = name; }
        else if (op.type === 'set_brief') doc.brief = op.brief;
        else throw new BadRequestException({ code: 'UNKNOWN_OPERATION', message: `不支持的操作 ${(op as any).type}` });
      }
      doc.revision = baseRevision + 1; doc.updatedByType = dto.actorType ?? lease.holderType; doc.updatedById = dto.actorId ?? lease.holderId;
      const updated = await canvasRepo.update({ id, revision: baseRevision }, { name: doc.name, graph: doc.graph, brief: doc.brief, revision: doc.revision, updatedByType: doc.updatedByType, updatedById: doc.updatedById } as any);
      if (updated.affected !== 1) this.fail(409, 'REVISION_CONFLICT', '画布被并发修改，请重新读取后重试');
      const canvas = await canvasRepo.findOneOrFail({ where: { id } });
      const response = { canvas, baseRevision, resultRevision: canvas.revision };
      await receiptRepo.save(receiptRepo.create({ canvasId: id, idempotencyKey: key, requestHash, resultRevision: canvas.revision, response }));
      return { ...response, replayed: false };
    });
  }
  async remove(id: string, proof?: Partial<LeaseProof>): Promise<void> { await this.requireLease(id, proof ?? {}); const doc = await this.findOne(id); if (proof?.expectedRevision !== (doc.revision ?? 0)) this.fail(409, 'REVISION_CONFLICT', '画布 revision 已变化', { expectedRevision: proof?.expectedRevision, currentRevision: doc.revision ?? 0 }); await this.assets.deleteCanvas(id); await this.repo.remove(doc); }

  private async requireLease(id: string, proof: Partial<Pick<LeaseProof, 'leaseToken' | 'leaseEpoch'>>) { const lease = await this.getNormalizedLease(id); if (!lease || ['expired','revoked'].includes(lease.status)) this.fail(410, 'LEASE_EXPIRED', '画布写入租约不存在或已过期'); if (proof.leaseEpoch !== lease.epoch) this.fail(409, 'STALE_LEASE', '租约 epoch 已变化', { currentEpoch: lease.epoch }); if (!proof.leaseToken || this.hash(proof.leaseToken) !== lease.tokenHash) this.fail(403, 'OPERATION_NOT_ALLOWED', '租约令牌无效'); return lease; }
  private async getNormalizedLease(canvasId: string) { const lease = await this.leases.findOne({ where: { canvasId } }); if (lease && ['active','handoff_pending'].includes(lease.status) && ((lease.serverInstanceId && lease.serverInstanceId !== SERVER_INSTANCE_ID) || new Date(lease.expiresAt).getTime() <= Date.now())) { lease.status = 'expired'; await this.leases.save(lease); } return lease; }
  private publicLease(l: CanvasControlLease) { return { canvasId: l.canvasId, epoch: l.epoch, holderType: l.holderType, holderId: l.holderId, status: l.status, acquiredAt: l.acquiredAt, lastHeartbeatAt: l.lastHeartbeatAt, expiresAt: l.expiresAt, handoffRequestedByType: l.handoffRequestedByType, handoffRequestedById: l.handoffRequestedById, lastTakeoverReason: l.lastTakeoverReason }; }
  private validateIdentity(v: LeaseIdentity) { if (!v || !['human','agent'].includes(v.holderType) || !v.holderId?.trim()) throw new BadRequestException({ code: 'INVALID_HOLDER', message: 'holderType 和 holderId 必填' }); }
  private hash(v: string) { return createHash('sha256').update(v).digest('hex'); }
  private fail(status: number, code: string, message: string, details?: unknown): never { throw new HttpException({ statusCode: status, code, message, details }, status); }
}

function isValidGraph(graph: CanvasGraph): boolean { return !!graph && typeof graph === 'object' && typeof graph.version === 'number' && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && (graph.viewport == null || (typeof graph.viewport === 'object' && typeof graph.viewport.x === 'number' && typeof graph.viewport.y === 'number' && typeof graph.viewport.zoom === 'number')); }
