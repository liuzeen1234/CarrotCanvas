import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SpeechEvaluationItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SpeechEvaluationStageResult {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unavailable';
  startedAt?: number;
  finishedAt?: number;
  toolVersion?: string;
  metrics?: Record<string, unknown>;
  error?: unknown;
}

@Entity('speech_evaluation_items')
@Index(['evaluationRunId', 'position'], { unique: true })
export class SpeechEvaluationItem {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'text', name: 'evaluation_run_id' }) evaluationRunId: string;
  @Column({ type: 'integer' }) position: number;
  @Column({ type: 'text', name: 'source_run_id', nullable: true }) sourceRunId: string | null;
  @Index() @Column({ type: 'text', name: 'target_asset_id' }) targetAssetId: string;
  @Column({ type: 'text', name: 'reference_asset_id', nullable: true }) referenceAssetId: string | null;
  @Column({ type: 'text', name: 'target_text', nullable: true }) targetText: string | null;
  @Column({ type: 'text' }) status: SpeechEvaluationItemStatus;
  @Column({ type: 'simple-json' }) stages: Record<string, SpeechEvaluationStageResult>;
  @Column({ type: 'simple-json', name: 'final_result', nullable: true }) finalResult: Record<string, unknown> | null;
  @Column({ type: 'simple-json', nullable: true }) error: unknown | null;
  @Column({ type: 'integer', name: 'started_at', nullable: true }) startedAt: number | null;
  @Column({ type: 'integer', name: 'finished_at', nullable: true }) finishedAt: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
