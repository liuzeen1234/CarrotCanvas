import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type GenerationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_attention';

@Entity('generation_runs')
@Index(['canvasId', 'nodeId', 'createdAt'])
export class GenerationRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'text' }) provider: 'comfyui' | 'codex2api';
  @Index() @Column({ type: 'text' }) status: GenerationRunStatus;
  @Index() @Column({ type: 'text', name: 'canvas_id', nullable: true }) canvasId: string | null;
  @Index() @Column({ type: 'text', name: 'node_id', nullable: true }) nodeId: string | null;
  @Index() @Column({ type: 'text', name: 'shot_id', nullable: true }) shotId: string | null;
  @Column({ type: 'text', name: 'parent_run_id', nullable: true }) parentRunId: string | null;
  @Column({ type: 'text', name: 'provider_run_id', nullable: true }) providerRunId: string | null;
  @Column({ type: 'text', name: 'capability_id', nullable: true }) capabilityId: string | null;
  @Column({ type: 'text', name: 'capability_version', nullable: true }) capabilityVersion: string | null;
  @Column({ type: 'simple-json', name: 'input_snapshot' }) inputSnapshot: unknown;
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
  @Column({ type: 'text', name: 'selected_asset_id', nullable: true }) selectedAssetId: string | null;
  @Column({ type: 'text', name: 'selected_run_id', nullable: true }) selectedRunId: string | null;
  @Column({ type: 'text', name: 'approved_asset_id', nullable: true }) approvedAssetId: string | null;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
