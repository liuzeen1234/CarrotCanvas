import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type LocalComputeProvider = 'comfyui' | 'cosyvoice3' | 'indextts2' | 'qwen3tts';
export type LocalComputeLeaseStatus = 'waiting' | 'preparing' | 'active' | 'releasing' | 'released' | 'failed' | 'abandoned';

@Entity('local_compute_leases')
@Index(['deviceKey', 'status'])
export class LocalComputeLease {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text', name: 'device_key', default: 'cuda:0' }) deviceKey: string;
  @Index() @Column({ type: 'text', name: 'run_id' }) runId: string;
  @Column({ type: 'text' }) provider: LocalComputeProvider;
  @Column({ type: 'text' }) status: LocalComputeLeaseStatus;
  @Column({ type: 'integer', name: 'queued_at' }) queuedAt: number;
  @Column({ type: 'integer', name: 'acquired_at', nullable: true }) acquiredAt: number | null;
  @Column({ type: 'integer', name: 'released_at', nullable: true }) releasedAt: number | null;
  @Column({ type: 'simple-json', nullable: true }) error: unknown | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

/** @deprecated Compatibility aliases; new code must use the local-compute names. */
export type GpuProvider = LocalComputeProvider;
export type GpuLeaseStatus = LocalComputeLeaseStatus;
export { LocalComputeLease as GpuResourceLease };
