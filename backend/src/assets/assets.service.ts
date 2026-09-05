import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { join, resolve, sep } from 'path';
import { existsSync, createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { Asset, AssetKind, AssetSource } from './asset.entity';
import { CanvasCheckpoint } from '../canvas/canvas.entity';

/**
 * 平台资产根目录：默认与 SQLite 文件同目录（backend/data/assets/）。
 * 可用环境变量 CARROT_ASSETS_ROOT 覆盖（测试时指向临时目录）。
 * 从编译产物 dist/assets/*.js 出发，../../ = backend。
 */
const ASSETS_ROOT =
  process.env.CARROT_ASSETS_ROOT || join(__dirname, '..', '..', 'data', 'assets');

/** 生成产物的写入入参（C2 运行捕获时调用） */
export interface SaveGeneratedInput {
  canvasId: string;
  /** 产生该产物的画布节点 id（覆盖清理键） */
  nodeId?: string | null;
  /** 来自哪次 ComfyUI 运行 */
  runPromptId?: string | null;
  /** 生成时绑定的工作流 id（仅溯源） */
  workflowId?: string | null;
  kind?: AssetKind;
  buffer: Buffer;
  originName?: string | null;
  mime?: string | null;
}

/** 用户上传入参图的写入入参（二期图生图，端点另行提供） */
export interface SaveUploadInput {
  canvasId: string;
  nodeId?: string | null;
  buffer: Buffer;
  originName?: string | null;
  mime?: string | null;
}

export interface AssetReadResult {
  asset: Asset;
  absPath: string;
}

/**
 * 资产存储：data/assets/<canvasId>/ 按画布分区，文件名 <assetId>__<safeName>，
 * 禁止任何用户输入直接拼路径（防目录穿越）。
 */
@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private readonly repo: Repository<Asset>,
    @Optional()
    @InjectRepository(CanvasCheckpoint)
    private readonly checkpoints?: Repository<CanvasCheckpoint>,
  ) {}

  // ---------- 分区 ----------

  /** 确保画布分区目录存在（generated/ + upload/），建画布时调用 */
  async ensureCanvasPartition(canvasId: string): Promise<void> {
    await fs.mkdir(join(ASSETS_ROOT, canvasId, 'generated'), { recursive: true });
    await fs.mkdir(join(ASSETS_ROOT, canvasId, 'upload'), { recursive: true });
  }

  // ---------- 写入 ----------

  /** 捕获一份生成产物：写 <canvasId>/generated/ 并建 asset 行（source=generated） */
  async saveGenerated(input: SaveGeneratedInput): Promise<Asset> {
    await this.ensureCanvasPartition(input.canvasId);
    const id = randomUUID();
    const relPath = `generated/${id}__${safeName(input.originName, 'generated')}`;
    const absPath = join(ASSETS_ROOT, input.canvasId, relPath);
    await fs.writeFile(absPath, input.buffer);
    const asset = this.repo.create({
      id,
      canvasId: input.canvasId,
      nodeId: input.nodeId ?? null,
      kind: input.kind ?? 'image',
      source: 'generated',
      runPromptId: input.runPromptId ?? null,
      workflowId: input.workflowId ?? null,
      relPath,
      originName: input.originName ?? null,
      mime: input.mime ?? null,
      size: input.buffer.length,
    });
    return this.repo.save(asset);
  }

  /** 存一份用户上传入参图副本到 <canvasId>/upload/（source=upload，二期图生图用） */
  async saveUpload(input: SaveUploadInput): Promise<Asset> {
    await this.ensureCanvasPartition(input.canvasId);
    const id = randomUUID();
    const relPath = `upload/${id}__${safeName(input.originName, 'upload')}`;
    const absPath = join(ASSETS_ROOT, input.canvasId, relPath);
    await fs.writeFile(absPath, input.buffer);
    const asset = this.repo.create({
      id,
      canvasId: input.canvasId,
      nodeId: input.nodeId ?? null,
      kind: 'image',
      source: 'upload',
      runPromptId: null,
      workflowId: null,
      relPath,
      originName: input.originName ?? null,
      mime: input.mime ?? null,
      size: input.buffer.length,
    });
    return this.repo.save(asset);
  }

  // ---------- 读取 ----------

  /** 按 id 定位 asset 行与磁盘文件（只按 id 查，不接受任意路径） */
  async read(id: string): Promise<AssetReadResult> {
    const asset = await this.repo.findOne({ where: { id } });
    if (!asset) {
      throw new NotFoundException(`资产 ${id} 不存在`);
    }
    const absPath = this.resolveAssetPath(asset);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`资产文件不存在：${asset.relPath}`);
    }
    return { asset, absPath };
  }

  /** 创建文件读取流（由 controller 交给响应） */
  createReadStream(absPath: string, options?: { start?: number; end?: number }) {
    return createReadStream(absPath, options);
  }

  // ---------- 统计 ----------

  /** 每张画布的资产总字节数（画布列表展示资产大小） */
  async getCanvasAssetSizes(): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('a')
      .select('a.canvas_id', 'canvasId')
      .addSelect('COALESCE(SUM(a.size), 0)', 'total')
      .groupBy('a.canvas_id')
      .getRawMany();
    const map: Record<string, number> = {};
    for (const r of rows) {
      map[r.canvasId as string] = Number(r.total) || 0;
    }
    return map;
  }

  // ---------- 清理 ----------

  /** 删画布级联：删除该画布分区的 asset 行 + 整目录 */
  async deleteCanvas(canvasId: string): Promise<void> {
    await this.repo.delete({ canvasId });
    await fs.rm(join(ASSETS_ROOT, canvasId), { recursive: true, force: true });
  }

  /**
   * 删除某生成节点的 generated 资产（行 + 文件）。
   * C2 覆盖清理策略（§4.6.4）：节点重跑成功后先建新、再清旧——
   * 调用方把本次新捕获的 assetId 传入 keepIds，这些行会被保留，只清旧版本。
   * 不带 keepIds 时删除该节点全部 generated 资产（删节点场景）。
   */
  async deleteGeneratedByNode(
    canvasId: string,
    nodeId: string,
    keepIds?: string[],
  ): Promise<void> {
    const assets = await this.repo.find({
      where: { canvasId, nodeId, source: 'generated' },
    });
    const protectedIds = await this.checkpointAssetIds(canvasId);
    for (const asset of assets) {
      if (keepIds?.includes(asset.id) || protectedIds.has(asset.id)) continue;
      await this.removeAssetRowAndFile(asset);
    }
  }

  /** 恢复点是强引用：只要其 graph 仍引用某资产，覆盖重跑和节点清理都不得删除。 */
  private async checkpointAssetIds(canvasId: string): Promise<Set<string>> {
    if (!this.checkpoints) return new Set();
    const checkpoints = await this.checkpoints.find({ where: { canvasId } });
    const ids = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.assetId === 'string' && record.assetId) ids.add(record.assetId);
      Object.values(record).forEach(visit);
    };
    checkpoints.forEach((checkpoint) => visit(checkpoint.graph));
    return ids;
  }

  private async removeAssetRowAndFile(asset: Asset): Promise<void> {
    try {
      await fs.rm(this.resolveAssetPath(asset), { force: true });
    } catch {
      // 文件可能已缺失，忽略后仍删行
    }
    await this.repo.delete(asset.id);
  }

  // ---------- 辅助 ----------

  /** 校验资产文件路径必须落在其画布分区内（防目录穿越，纵深防御） */
  private resolveAssetPath(asset: Asset): string {
    const root = resolve(ASSETS_ROOT);
    const partition = resolve(join(root, asset.canvasId));
    const target = resolve(join(partition, asset.relPath));
    if (!target.startsWith(partition + sep)) {
      throw new BadRequestException(`非法的资产路径：${asset.relPath}`);
    }
    return target;
  }
}

/**
 * 路径清洗：只保留可读原名并去掉路径分隔符 / 危险字符 / 首尾点，
 * 保证 <assetId>__<safeName> 不会越出分区目录。
 */
export function safeName(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  const result = (cleaned || fallback).replace(/\.\./g, '_');
  return result;
}
