import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type GpuProvider = 'comfyui' | 'cosyvoice3' | 'indextts2';
export type GpuLeaseStatus = 'waiting' | 'preparing' | 'active' | 'releasing' | 'released' | 'failed' | 'abandoned';

@Entity('gpu_resource_leases')
@Index(['deviceKey', 'status'])
export class GpuResourceLease {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text', name: 'device_key', default: 'cuda:0' }) deviceKey: string;
  @Index() @Column({ type: 'text', name: 'run_id' }) runId: string;
  @Column({ type: 'text' }) provider: GpuProvider;
  @Column({ type: 'text' }) status: GpuLeaseStatus;
  @Column({ type: 'integer', name: 'queued_at' }) queuedAt: number;
  @Column({ type: 'integer', name: 'acquired_at', nullable: true }) acquiredAt: number | null;
  @Column({ type: 'integer', name: 'released_at', nullable: true }) releasedAt: number | null;
  @Column({ type: 'simple-json', nullable: true }) error: unknown | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
