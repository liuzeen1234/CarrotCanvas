import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WorkflowCategory } from './workflow-category';

@Entity('workflows')
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'reference' })
  category: WorkflowCategory;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'simple-json', nullable: true })
  tags: string[] | null;

  @Column({ type: 'text', name: 'api_json' })
  apiJson: string;

  @Column({ type: 'text', name: 'thumbnail_path', nullable: true })
  thumbnailPath: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
