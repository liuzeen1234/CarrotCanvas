import { Injectable, NotFoundException, BadRequestException, Optional, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { join, resolve, sep } from 'path';
import { existsSync, createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { Asset, AssetKind, AssetSource } from './asset.entity';
import { CanvasCheckpoint, CanvasDoc } from '../canvas/canvas.entity';
import { GenerationCandidateGroup, GenerationRun } from '../runs/generation-run.entity';

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
  kind?: AssetKind;
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
export class AssetsService implements OnModuleInit {
  private readonly readers = new Map<string, number>();
  private readonly deleting = new Set<string>();
  constructor(
    @InjectRepository(Asset)
    private readonly repo: Repository<Asset>,
    @Optional()
    @InjectRepository(CanvasCheckpoint)
    private readonly checkpoints?: Repository<CanvasCheckpoint>,
    @Optional()
    @InjectRepository(GenerationCandidateGroup)
    private readonly candidateGroups?: Repository<GenerationCandidateGroup>,
  ) {}

  /** A source partition cannot disappear while an immutable snapshot is copied. */
  async withReadProtection<T>(canvasId: string, work: () => Promise<T>): Promise<T> {
    if (this.deleting.has(canvasId)) throw new ConflictException({ code: 'SOURCE_UNAVAILABLE', message: '来源正在删除，请稍后重试' });
    this.readers.set(canvasId, (this.readers.get(canvasId) ?? 0) + 1);
    try { return await work(); }
    finally { const count = (this.readers.get(canvasId) ?? 1) - 1; if (count) this.readers.set(canvasId, count); else this.readers.delete(canvasId); }
  }
  async withDeleteProtection<T>(canvasId: string, work: () => Promise<T>): Promise<T> {
    if (this.readers.has(canvasId) || this.deleting.has(canvasId)) throw new ConflictException({ code: 'SOURCE_COPY_IN_PROGRESS', message: '来源正在复制或删除，请稍后重试' });
    this.deleting.add(canvasId); try { return await work(); } finally { this.deleting.delete(canvasId); }
  }

  async prepareImport(input: SaveUploadInput): Promise<Asset> {
    await fs.mkdir(join(ASSETS_ROOT, input.canvasId, 'input'), { recursive: true });
    const id = randomUUID();
    const relPath = `input/${id}__${safeName(input.originName, 'input')}`;
    const asset = this.repo.create({ id, canvasId: input.canvasId, nodeId: null, kind: input.kind ?? 'image', source: 'import', runPromptId: null, workflowId: null, relPath, originName: input.originName ?? null, mime: input.mime ?? null, size: input.buffer.length });
    await fs.writeFile(this.resolveAssetPath(asset), input.buffer, { flag: 'wx' });
    return asset;
  }

  async prepareCopy(canvasId: string, sourceId: string): Promise<{ asset: Asset; hash: string }> {
    const { asset: source, absPath } = await this.read(sourceId);
    await fs.mkdir(join(ASSETS_ROOT, canvasId, 'input'), { recursive: true });
    const id = randomUUID();
    const asset = this.repo.create({ ...source, id, canvasId, nodeId: null, source: 'import', relPath: `input/${id}__${safeName(source.originName, 'input')}`, createdAt: undefined });
    const target = this.resolveAssetPath(asset);
    try { await fs.copyFile(absPath, target); return { asset, hash: await this.fileHash(target) }; }
    catch (error) { await fs.rm(target, { force: true }).catch(() => undefined); throw error; }
  }

  async fileHash(path: string): Promise<string> { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }
  async discardPrepared(assets: Asset[]): Promise<void> { for (const asset of assets) if (!await this.repo.exist({ where: { id: asset.id } })) await fs.rm(this.resolveAssetPath(asset), { force: true }).catch(() => undefined); }

  /** Recover only orphan snapshot files, never legacy/provider assets. */
  async onModuleInit() {
    if (!existsSync(ASSETS_ROOT)) return;
    const partitions = await fs.readdir(ASSETS_ROOT, { withFileTypes: true });
    for (const partition of partitions.filter(p => p.isDirectory())) {
      const folder = join(ASSETS_ROOT, partition.name, 'input');
      if (!existsSync(folder)) continue;
      for (const file of await fs.readdir(folder, { withFileTypes: true })) {
        if (!file.isFile() || !/^[0-9a-f-]{36}__/.test(file.name)) continue;
        const path = join(folder, file.name); const stat = await fs.stat(path);
        if (Date.now() - stat.mtimeMs > 86400000 && !await this.repo.exist({ where: { id: file.name.slice(0, 36) } })) await fs.rm(path, { force: true });
      }
    }
  }

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
    try { return await this.repo.save(asset); }
    catch (error) { await fs.rm(absPath, { force: true }).catch(() => undefined); throw error; }
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
      kind: input.kind ?? 'image',
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
    if (this.readers.has(canvasId)) throw new ConflictException({ code: 'SOURCE_COPY_IN_PROGRESS', message: '正在复制该来源，请稍后删除' });
    this.deleting.add(canvasId);
    try { await this.repo.delete({ canvasId }); await fs.rm(join(ASSETS_ROOT, canvasId), { recursive: true, force: true }); }
    finally { this.deleting.delete(canvasId); }
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
    if (this.readers.has(canvasId)) throw new ConflictException({ code: 'SOURCE_COPY_IN_PROGRESS', message: '来源正在复制，资产清理稍后重试' });
    const assets = await this.repo.find({
      where: { canvasId, nodeId, source: 'generated' },
    });
    const protectedIds = await this.checkpointAssetIds(canvasId);
    if (this.repo.manager?.connection?.hasMetadata(CanvasDoc)) {
      const doc = await this.repo.manager.getRepository(CanvasDoc).findOne({ where: { id: canvasId } });
      collectAssetIds(doc?.graph, protectedIds); collectAssetIds(doc?.io, protectedIds);
    }
    if (this.repo.manager?.connection?.hasMetadata(GenerationRun)) {
      for (const run of await this.repo.manager.getRepository(GenerationRun).find({ where: { canvasId } })) { run.inputAssetIds.forEach(id => protectedIds.add(id)); run.outputAssetIds.forEach(id => protectedIds.add(id)); }
    }
    if (this.candidateGroups) {
      const groups = await this.candidateGroups.find({ where: { canvasId } });
      for (const group of groups) if (group.approvedAssetId) protectedIds.add(group.approvedAssetId);
    }
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
    checkpoints.forEach((checkpoint) => { visit(checkpoint.graph); visit(checkpoint.io); });
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
    if (!partition.startsWith(root + sep) || !target.startsWith(partition + sep)) {
      throw new BadRequestException(`非法的资产路径：${asset.relPath}`);
    }
    return target;
  }
}

function collectAssetIds(value: unknown, ids: Set<string>) {
  if (Array.isArray(value)) { value.forEach(v => collectAssetIds(v, ids)); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>; if (typeof record.assetId === 'string') ids.add(record.assetId);
  Object.values(record).forEach(v => collectAssetIds(v, ids));
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
