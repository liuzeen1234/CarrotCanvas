import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type GenerationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_attention';

/** Success refers to registering a recovered output, not to a new provider invocation. */
export interface RunRecovery {
  kind?: 'recovery' | 'canvas_migration';
  sourceRunId: string;
  sourceStatus: GenerationRunStatus;
  sourceCanvasId?: string;
  sourceAssetId?: string;
  reason: string;
  evidence: string;
  recoveredAt: number;
  leaseEpoch: number;
}

@Entity('generation_runs')
@Index(['canvasId', 'nodeId', 'createdAt'])
export class GenerationRun {
  @Column({ type: 'simple-json', name: 'input_lineage', nullable: true }) inputLineage: Array<{ inputGroupId: string; snapshotId: string; itemKey: string; assetId: string; name?: string; sourceCanvasId?: string; sourceCanvasName?: string; sourceOutputsVersion?: number; sourceOutputId?: string; sourceAssetId?: string }> | null;
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'text' }) provider: 'comfyui' | 'codex2api' | 'cosyvoice3' | 'indextts2' | 'qwen3tts';
  @Index() @Column({ type: 'text' }) status: GenerationRunStatus;
  @Index() @Column({ type: 'text', name: 'canvas_id', nullable: true }) canvasId: string | null;
  @Index() @Column({ type: 'text', name: 'node_id', nullable: true }) nodeId: string | null;
  @Index() @Column({ type: 'text', name: 'shot_id', nullable: true }) shotId: string | null;
  @Column({ type: 'text', name: 'parent_run_id', nullable: true }) parentRunId: string | null;
  @Column({ type: 'simple-json', nullable: true }) recovery: RunRecovery | null;
  @Column({ type: 'text', name: 'provider_run_id', nullable: true }) providerRunId: string | null;
  @Column({ type: 'text', name: 'capability_id', nullable: true }) capabilityId: string | null;
  @Column({ type: 'text', name: 'capability_version', nullable: true }) capabilityVersion: string | null;
  @Column({ type: 'simple-json', name: 'input_snapshot' }) inputSnapshot: unknown;
  /** Stable request identity, independent of provider-side input preparation. */
  @Column({ type: 'simple-json', name: 'request_snapshot', nullable: true }) requestSnapshot: unknown | null;
  @Column({ type: 'simple-json', name: 'input_asset_ids' }) inputAssetIds: string[];
  @Column({ type: 'simple-json', name: 'output_asset_ids' }) outputAssetIds: string[];
  @Column({ type: 'text', name: 'output_text', nullable: true }) outputText: string | null;
  @Column({ type: 'simple-json', name: 'output_parts', nullable: true }) outputParts: { positive: string; negative: string } | null;
  @Column({ type: 'text', name: 'actor_type' }) actorType: 'human' | 'agent';
  @Column({ type: 'text', name: 'actor_id' }) actorId: string;
  @Column({ type: 'integer', name: 'attempt_count', default: 1 }) attemptCount: number;
  @Column({ type: 'text', name: 'idempotency_key', nullable: true, unique: true }) idempotencyKey: string | null;
  @Column({ type: 'simple-json', nullable: true }) error: unknown | null;
  @Column({ type: 'integer', name: 'queued_at' }) queuedAt: number;
  @Column({ type: 'integer', name: 'started_at', nullable: true }) startedAt: number | null;
  @Column({ type: 'integer', name: 'finished_at', nullable: true }) finishedAt: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

export type RunHandoffOutcome = 'released' | 'adopted' | 'release_failed';

/** Immutable audit trail for control changes around an existing provider task. */
@Entity('generation_run_handoffs')
@Index(['runId', 'createdAt'])
export class GenerationRunHandoff {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'text', name: 'run_id' }) runId: string;
  @Index() @Column({ type: 'text', name: 'canvas_id' }) canvasId: string;
  @Column({ type: 'text', name: 'provider_run_id', nullable: true }) providerRunId: string | null;
  @Column({ type: 'text', name: 'run_status' }) runStatus: GenerationRunStatus;
  @Column({ type: 'text', name: 'from_actor_type' }) fromActorType: 'human' | 'agent';
  @Column({ type: 'text', name: 'from_actor_id' }) fromActorId: string;
  @Column({ type: 'integer', name: 'from_lease_epoch' }) fromLeaseEpoch: number;
  @Column({ type: 'text', name: 'to_actor_type', nullable: true }) toActorType: 'human' | 'agent' | null;
  @Column({ type: 'text', name: 'to_actor_id', nullable: true }) toActorId: string | null;
  @Column({ type: 'integer', name: 'to_lease_epoch', nullable: true }) toLeaseEpoch: number | null;
  @Column({ type: 'text', default: 'released' }) outcome: RunHandoffOutcome;
  @Column({ type: 'text', nullable: true }) summary: string | null;
  @Column({ type: 'simple-json', name: 'output_asset_ids' }) outputAssetIds: string[];
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('generation_candidate_groups')
@Index(['canvasId', 'nodeId', 'shotId'], { unique: true })
export class GenerationCandidateGroup {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text', name: 'canvas_id' }) canvasId: string;
  @Column({ type: 'text', name: 'node_id', nullable: true }) nodeId: string | null;
  @Column({ type: 'text', name: 'shot_id', nullable: true }) shotId: string | null;
  @Column({ type: 'simple-json', name: 'candidate_asset_ids' }) candidateAssetIds: string[];
  /** 每个产物 kind 各自记住当前选中的资产；一次 run 可同时产出视频与音频等多 kind，需分别默认选中最新。 */
  @Column({ type: 'simple-json', name: 'selected_by_kind', nullable: true }) selectedByKind: Partial<Record<'image' | 'video' | 'audio', string>> | null;
  /** 主 kind 的选中（向后兼容旧字段），有视频取视频、否则图、否则音频。 */
  @Column({ type: 'text', name: 'selected_asset_id', nullable: true }) selectedAssetId: string | null;
  @Column({ type: 'text', name: 'selected_run_id', nullable: true }) selectedRunId: string | null;
  @Column({ type: 'text', name: 'approved_asset_id', nullable: true }) approvedAssetId: string | null;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
