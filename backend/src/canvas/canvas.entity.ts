import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** 序列化节点图：React Flow 图 + 视口。见 docs/CANVAS-INTEGRATION.md §4.1 */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasGraph {
  version: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport | null;
}

export interface CanvasNode {
  id: string;
  type: 'txt2img' | 'result' | 'codex-capability';
  position: { x: number; y: number };
  data: Record<string, unknown>;
  style?: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

export function emptyCanvasGraph(): CanvasGraph {
  return { version: 1, nodes: [], edges: [], viewport: null };
}

/**
 * 画布文档（canvas_docs）。
 * id 同时作为资产分区目录键（data/assets/<canvasId>/）。
 */
@Entity('canvas_docs')
export class CanvasDoc {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'simple-json' })
  graph: CanvasGraph;

  @Column({ type: 'integer', default: 0 })
  revision: number;

  @Column({ name: 'schema_version', type: 'integer', default: 1 })
  schemaVersion: number;

  @Column({ type: 'simple-json', nullable: true })
  brief: Record<string, unknown> | null;

  @Column({ name: 'active_checkpoint_id', type: 'text', nullable: true })
  activeCheckpointId: string | null;

  @Column({ name: 'last_handoff_id', type: 'text', nullable: true })
  lastHandoffId: string | null;

  @Column({ name: 'updated_by_type', type: 'text', nullable: true })
  updatedByType: 'human' | 'agent' | null;

  @Column({ name: 'updated_by_id', type: 'text', nullable: true })
  updatedById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

@Entity('canvas_control_leases')
export class CanvasControlLease {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'canvas_id', type: 'text', unique: true })
  canvasId: string;

  @Column({ type: 'integer', default: 0 })
  epoch: number;

  @Column({ name: 'holder_type', type: 'text' })
  holderType: 'human' | 'agent';

  @Column({ name: 'holder_id', type: 'text' })
  holderId: string;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ type: 'text', default: 'expired' })
  status: 'active' | 'handoff_pending' | 'expired' | 'revoked';

  @Column({ name: 'handoff_requested_by_type', type: 'text', nullable: true })
  handoffRequestedByType: 'human' | 'agent' | null;

  @Column({ name: 'handoff_requested_by_id', type: 'text', nullable: true })
  handoffRequestedById: string | null;

  @Column({ name: 'last_takeover_reason', type: 'text', nullable: true })
  lastTakeoverReason: string | null;

  @Column({ name: 'acquired_at', type: 'datetime' })
  acquiredAt: Date;

  @Column({ name: 'last_heartbeat_at', type: 'datetime' })
  lastHeartbeatAt: Date;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;

  @Column({ name: 'server_instance_id', type: 'text' })
  serverInstanceId: string;
}

@Entity('canvas_operation_receipts')
@Index(['canvasId', 'idempotencyKey'], { unique: true })
export class CanvasOperationReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'canvas_id', type: 'text' })
  canvasId: string;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ name: 'request_hash', type: 'text' })
  requestHash: string;

  @Column({ name: 'result_revision', type: 'integer' })
  resultRevision: number;

  @Column({ type: 'simple-json' })
  response: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

@Entity('canvas_operation_logs')
@Index(['canvasId', 'resultRevision'], { unique: true })
export class CanvasOperationLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'canvas_id', type: 'text' }) canvasId: string;
  @Column({ name: 'base_revision', type: 'integer' }) baseRevision: number;
  @Column({ name: 'result_revision', type: 'integer' }) resultRevision: number;
  @Column({ name: 'lease_epoch', type: 'integer' }) leaseEpoch: number;
  @Column({ name: 'actor_type', type: 'text' }) actorType: 'human' | 'agent';
  @Column({ name: 'actor_id', type: 'text' }) actorId: string;
  @Column({ type: 'text', nullable: true }) intent: string | null;
  @Column({ type: 'simple-json' }) operations: Record<string, unknown>[];
  @Column({ name: 'inverse_operations', type: 'simple-json' }) inverseOperations: Record<string, unknown>[];
  @Column({ name: 'idempotency_key', type: 'text' }) idempotencyKey: string;
  @Column({ name: 'undone_by_log_id', type: 'text', nullable: true }) undoneByLogId: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('canvas_checkpoints')
export class CanvasCheckpoint {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'canvas_id', type: 'text' }) canvasId: string;
  @Column({ type: 'text' }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'integer' }) revision: number;
  @Column({ name: 'canvas_name', type: 'text' }) canvasName: string;
  @Column({ type: 'simple-json' }) graph: CanvasGraph;
  @Column({ type: 'simple-json', nullable: true }) brief: Record<string, unknown> | null;
  @Column({ name: 'created_by_type', type: 'text' }) createdByType: 'human' | 'agent';
  @Column({ name: 'created_by_id', type: 'text' }) createdById: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('canvas_asset_gc_jobs')
export class CanvasAssetGcJob {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'canvas_id', type: 'text' }) canvasId: string;
  @Column({ name: 'node_id', type: 'text' }) nodeId: string;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string | null;
  @Column({ name: 'last_attempt_at', type: 'datetime', nullable: true }) lastAttemptAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
