import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 序列化节点图：React Flow 图 + 视口。见 docs/CANVAS-INTEGRATION.md §4.1 */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasGraph {
  version: number;
  nodes: unknown[];
  edges: unknown[];
  viewport: CanvasViewport | null;
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
