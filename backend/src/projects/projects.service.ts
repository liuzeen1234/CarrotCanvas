import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { EntityManager, Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetsService } from '../assets/assets.service';
import { CanvasAssetGcJob, CanvasDoc, emptyCanvasGraph } from '../canvas/canvas.entity';
import { currentOutput, emptyCanvasIo, IoItem } from '../canvas/canvas-io.types';
import { bounded, snapshot } from '../canvas/canvas-io.service';
import { CanvasService } from '../canvas/canvas.service';
import { Project, ProjectCanvas, ProjectReceipt } from './project.entity';
import { domainTransaction } from '../database/domain-transaction';

export interface ProjectCommand { expectedRevision: number; idempotencyKey: string; command: string; payload?: any; actorId?: string; }
@Injectable()
export class ProjectsService {
  constructor(@InjectRepository(Project) private readonly projects: Repository<Project>, private readonly assets: AssetsService, private readonly canvas: CanvasService) {}
  async list() {
    const projects = await this.projects.find({ order: { updatedAt: 'DESC' } }); const links = await this.projects.manager.getRepository(ProjectCanvas).find(); const sizes = await this.assets.getCanvasAssetSizes();
    return projects.map(({ results, ...project }) => ({ ...project, canvasCount: links.filter(l => l.projectId === project.id).length, resultCount: results.find(s => s.id === project.activeResultId)?.items.length ?? 0, assetSize: sizes[`project-${project.id}`] ?? 0 }));
  }
  async get(id: string) { const project = await this.projects.findOne({ where: { id } }); if (!project) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: '项目不存在' }); const links = await this.projects.manager.getRepository(ProjectCanvas).find({ where: { projectId: id } }); return { ...project, canvases: (await this.canvas.list()).filter(c => links.some(l => l.canvasId === c.id)) }; }
  async create(dto: { name?: string; description?: string }) { return this.projects.save(this.projects.create({ name: bounded(dto.name, '新项目'), description: bounded(dto.description, '', 2000), revision: 0, results: [], activeResultId: null })); }

  private identity(dto: ProjectCommand) { if (!dto.idempotencyKey || typeof dto.idempotencyKey !== 'string' || !Number.isInteger(dto.expectedRevision)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: '需要 expectedRevision 和 idempotencyKey' }); return createHash('sha256').update(JSON.stringify({ expectedRevision: dto.expectedRevision, command: dto.command, payload: dto.payload ?? {} })).digest('hex'); }
  async command(id: string, dto: ProjectCommand) {
    const hash = this.identity(dto); const payload = dto.payload ?? {}; const existing = await this.projects.manager.getRepository(ProjectReceipt).findOne({ where: { projectId: id, key: dto.idempotencyKey } });
    if (existing) { if (hash !== existing.hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '幂等键已用于不同请求' }); return { ...existing.response, replayed: true }; }
    const project = await this.get(id); this.revision(project, dto.expectedRevision);
    const prepared: Asset[] = []; const items: IoItem[] = [];
    try {
      if (dto.command === 'results.capture') {
        if (!Array.isArray(payload.selections) || payload.selections.length > 100) throw new BadRequestException('请选择不超过 100 个输出');
        const selectedKeys = new Set<string>();
        for (const selection of payload.selections) {
          const key = `${selection.canvasId}:${selection.itemKey}`; if (selectedKeys.has(key)) throw new BadRequestException('同一输出不能重复收集'); selectedKeys.add(key);
          if (!project.canvases.some(c => c.id === selection.canvasId)) throw new BadRequestException({ code: 'CANVAS_NOT_IN_PROJECT', message: '只能收集当前项目关联画布的输出' });
          await this.assets.withReadProtection(selection.canvasId, async () => {
            const source = await this.canvas.findOne(selection.canvasId); const output = currentOutput(source.io ?? emptyCanvasIo());
            if (!output || output.version !== selection.outputsVersion) throw new ConflictException({ code: 'SOURCE_VERSION_CHANGED', message: '来源输出变化，请重新选择' });
            const item = output.items.find(i => i.itemKey === selection.itemKey); if (!item) throw new BadRequestException('输出项不存在');
            const copy = await this.assets.prepareCopy(`project-${id}`, item.assetId); prepared.push(copy.asset); if (copy.hash !== item.hash) throw new BadRequestException('文件校验失败');
            items.push({ ...item, itemKey: randomUUID(), assetId: copy.asset.id, name: bounded(selection.name, item.name), note: bounded(selection.note, item.note, 2000), sourceCanvasId: source.id, sourceCanvasName: source.name, sourceOutputId: item.itemKey, sourceOutputsVersion: output.version, sourceAssetId: item.assetId });
          });
        }
      }
      return await domainTransaction(this.projects.manager, async manager => {
        const receiptRepo = manager.getRepository(ProjectReceipt); const receipt = await receiptRepo.findOne({ where: { projectId: id, key: dto.idempotencyKey } });
        if (receipt) { if (receipt.hash !== hash) throw new ConflictException('幂等键冲突'); return { ...receipt.response, replayed: true }; }
        const repo = manager.getRepository(Project); const draft = await repo.findOne({ where: { id } }); if (!draft) throw new NotFoundException('项目不存在'); this.revision(draft, dto.expectedRevision);
        const links = manager.getRepository(ProjectCanvas); let createdCanvasId: string | undefined;
        if (dto.command === 'edit') { draft.name = bounded(payload.name, draft.name); draft.description = bounded(payload.description, draft.description, 2000); }
        else if (dto.command === 'canvas.add') {
          if (!await manager.getRepository(CanvasDoc).exist({ where: { id: payload.canvasId } })) throw new NotFoundException('画布不存在');
          if (!await links.exist({ where: { projectId: id, canvasId: payload.canvasId } })) await links.save(links.create({ projectId: id, canvasId: payload.canvasId }));
        } else if (dto.command === 'canvas.remove') await links.delete({ projectId: id, canvasId: payload.canvasId });
        else if (dto.command === 'canvas.create') {
          const canvasRepo = manager.getRepository(CanvasDoc); const created = await canvasRepo.save(canvasRepo.create({ id: randomUUID(), name: bounded(payload.name, '新画布'), graph: emptyCanvasGraph(), io: null, revision: 0, schemaVersion: 1, brief: null, activeCheckpointId: null, lastHandoffId: null, updatedByType: null, updatedById: null }));
          await this.assets.ensureCanvasPartition(created.id); await links.save(links.create({ projectId: id, canvasId: created.id })); createdCanvasId = created.id;
        } else if (dto.command === 'results.capture') {
          for (const selection of payload.selections) if (!await links.exist({ where: { projectId: id, canvasId: selection.canvasId } })) throw new ConflictException('画布已从项目移出，请重新收集');
          await manager.getRepository(Asset).save(prepared); const result = { ...snapshot(items, draft.results.length + 1, dto.actorId ?? ''), name: bounded(payload.name, '项目成果'), note: bounded(payload.note, '', 2000) };
          draft.results.push(result); draft.activeResultId = result.id;
        } else if (dto.command === 'results.restore') { if (!draft.results.some(s => s.id === payload.snapshotId)) throw new BadRequestException('快照不存在'); draft.activeResultId = payload.snapshotId; }
        else throw new BadRequestException('不支持的项目命令');
        draft.revision++; const updated = await repo.update({ id, revision: dto.expectedRevision }, { name: draft.name, description: draft.description, results: draft.results, activeResultId: draft.activeResultId, revision: draft.revision });
        if (updated.affected !== 1) throw new ConflictException({ code: 'REVISION_CONFLICT', message: '项目已变化，请刷新后重试' });
        const response = { project: await repo.findOneOrFail({ where: { id } }), ...(createdCanvasId ? { createdCanvasId } : {}) }; await receiptRepo.save(receiptRepo.create({ projectId: id, key: dto.idempotencyKey, hash, response })); return response;
      });
    } finally { await this.assets.discardPrepared(prepared); }
  }
  async remove(id: string, expectedRevision: number) {
    let jobId: string | undefined;
    await domainTransaction(this.projects.manager, async manager => {
      const repo = manager.getRepository(Project); const project = await repo.findOne({ where: { id } }); if (!project) throw new NotFoundException('项目不存在'); this.revision(project, expectedRevision);
      if (await manager.getRepository(ProjectCanvas).count({ where: { projectId: id } })) throw new ConflictException({ code: 'PROJECT_NOT_EMPTY', message: '项目仍包含画布，请先移出所有画布' });
      await repo.delete({ id, revision: expectedRevision }); await manager.getRepository(ProjectReceipt).delete({ projectId: id });
      await manager.getRepository(Asset).delete({ canvasId: `project-${id}` });
      const gc = manager.getRepository(CanvasAssetGcJob); const job = await gc.save(gc.create({ canvasId: `project-${id}`, nodeId: '__canvas_partition__', attempts: 0, lastError: null, lastAttemptAt: null })); jobId = job.id;
    });
    try { await this.assets.deleteCanvas(`project-${id}`); if (jobId) await this.projects.manager.getRepository(CanvasAssetGcJob).delete(jobId); }
    catch { /* Canonical deletion committed; persistent GC job retries after restart. */ }
    return { ok: true };
  }
  private revision(project: Project, expected: number) { if (project.revision !== expected) throw new ConflictException({ code: 'REVISION_CONFLICT', message: '项目已变化，请刷新后重试', currentRevision: project.revision }); }
}
