import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasDoc, CanvasGraph, emptyCanvasGraph } from './canvas.entity';
import { AssetsService } from '../assets/assets.service';

/** 画布列表项：不回大 graph，只回元信息 + 节点数 + 资产大小 */
export interface CanvasListItem {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  nodeCount: number;
  assetSize: number;
}

/** 新建画布入参 */
export interface CreateCanvasDto {
  name?: string;
}

/** 更新画布入参：改名 / 保存 graph */
export interface UpdateCanvasDto {
  name?: string;
  graph?: CanvasGraph;
}

const DEFAULT_CANVAS_NAME = '未命名画布';

@Injectable()
export class CanvasService {
  constructor(
    @InjectRepository(CanvasDoc)
    private readonly repo: Repository<CanvasDoc>,
    private readonly assets: AssetsService,
  ) {}

  /** 画布列表（只回元信息，不回大 graph） */
  async list(): Promise<CanvasListItem[]> {
    const docs = await this.repo.find({ order: { updatedAt: 'DESC' } });
    const sizes = await this.assets.getCanvasAssetSizes();
    return docs.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      nodeCount: Array.isArray(d.graph?.nodes) ? d.graph.nodes.length : 0,
      assetSize: sizes[d.id] ?? 0,
    }));
  }

  /** 新建画布：空图 + 创建其资产分区目录 */
  async create(dto: CreateCanvasDto): Promise<CanvasDoc> {
    const doc = this.repo.create({
      name: (dto.name ?? '').trim() || DEFAULT_CANVAS_NAME,
      graph: emptyCanvasGraph(),
    });
    const saved = await this.repo.save(doc);
    await this.assets.ensureCanvasPartition(saved.id);
    return saved;
  }

  /** 取单个画布（含完整 graph） */
  async findOne(id: string): Promise<CanvasDoc> {
    const doc = await this.repo.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`画布 ${id} 不存在`);
    }
    return doc;
  }

  /** 改名 / 保存 graph */
  async update(id: string, dto: UpdateCanvasDto): Promise<CanvasDoc> {
    const doc = await this.findOne(id);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('画布名不能为空');
      }
      doc.name = name;
    }
    if (dto.graph !== undefined) {
      if (!isValidGraph(dto.graph)) {
        throw new BadRequestException('graph 结构不合法（需 { version, nodes, edges, viewport }）');
      }
      doc.graph = dto.graph;
    }
    return this.repo.save(doc);
  }

  /** 删除画布：级联删除其资产分区目录与 asset 行 */
  async remove(id: string): Promise<void> {
    const doc = await this.findOne(id);
    await this.assets.deleteCanvas(id);
    await this.repo.remove(doc);
  }
}

function isValidGraph(graph: CanvasGraph): boolean {
  if (!graph || typeof graph !== 'object') return false;
  if (typeof graph.version !== 'number') return false;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  if (
    graph.viewport !== null &&
    graph.viewport !== undefined &&
    (typeof graph.viewport !== 'object' ||
      typeof graph.viewport.x !== 'number' ||
      typeof graph.viewport.y !== 'number' ||
      typeof graph.viewport.zoom !== 'number')
  ) {
    return false;
  }
  return true;
}
