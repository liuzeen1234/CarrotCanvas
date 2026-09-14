import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { IoSnapshot } from '../canvas/canvas-io.types';
@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) name: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @Column({ type: 'simple-json', default: '[]' }) results: IoSnapshot[];
  @Column({ type: 'text', nullable: true, name: 'active_result_id' }) activeResultId: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
@Entity('project_canvases')
@Index(['projectId', 'canvasId'], { unique: true })
export class ProjectCanvas {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'text', name: 'project_id' }) projectId: string;
  @Index() @Column({ type: 'text', name: 'canvas_id' }) canvasId: string;
}
@Entity('project_receipts')
@Index(['projectId', 'key'], { unique: true })
export class ProjectReceipt {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) projectId: string;
  @Column({ type: 'text' }) key: string;
  @Column({ type: 'text' }) hash: string;
  @Column({ type: 'simple-json' }) response: Record<string, unknown>;
}
