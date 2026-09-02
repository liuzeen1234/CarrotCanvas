import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/** 资产内容类型 */
export type AssetKind = 'image' | 'video' | 'audio';

/** 资产来源 */
export type AssetSource = 'generated' | 'upload';

/**
 * 平台资产（assets）。一切中间产物（生成图 / 上传图 / 视频等）都存到
 * data/assets/<canvasId>/ 分区，画布展示只走平台资产 URL，不依赖 ComfyUI。
 * 见 docs/CANVAS-INTEGRATION.md §4.6。
 */
@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 归属画布（分区键）；删画布时级联删行 */
  @Index()
  @Column({ type: 'text', name: 'canvas_id' })
  canvasId: string;

  /** 由哪个画布节点产生/使用 */
  @Column({ type: 'text', name: 'node_id', nullable: true })
  nodeId: string | null;

  @Column({ type: 'text' })
  kind: AssetKind;

  @Column({ type: 'text' })
  source: AssetSource;

  /** 来自哪次 ComfyUI 运行 */
  @Column({ type: 'text', name: 'run_prompt_id', nullable: true })
  runPromptId: string | null;

  /** 生成时绑定的工作流，仅溯源；工作流删除不影响资产 */
  @Column({ type: 'text', name: 'workflow_id', nullable: true })
  workflowId: string | null;

  /** 相对 data/assets 的路径（含分区子目录，如 generated/<id>__<safeName>） */
  @Column({ type: 'text', name: 'rel_path' })
  relPath: string;

  /** ComfyUI 输出名 / 上传原始名 */
  @Column({ type: 'text', name: 'origin_name', nullable: true })
  originName: string | null;

  @Column({ type: 'text', nullable: true })
  mime: string | null;

  @Column({ type: 'integer', nullable: true })
  size: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
