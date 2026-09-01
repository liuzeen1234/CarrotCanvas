import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WorkflowCategory } from './workflow-category';

/** 单个被暴露的入参字段引用 */
export interface ExposedField {
  nodeId: string;
  param: string;
}

/** 暴露字段配置 */
export interface ExposureConfig {
  version: number;
  fields: ExposedField[];
}

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

  /**
   * 暴露字段配置：记录运行面板中默认展开（对外暴露）的入参字段。
   * null 表示未配置 → 运行面板回退为"全部平铺"。
   */
  @Column({ type: 'simple-json', name: 'exposure_config', nullable: true })
  exposureConfig: ExposureConfig | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
