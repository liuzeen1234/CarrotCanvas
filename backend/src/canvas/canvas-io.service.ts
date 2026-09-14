import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { TextDecoder } from 'util';
import { Asset, AssetKind } from '../assets/asset.entity';
import { AssetsService } from '../assets/assets.service';
import { GenerationRun } from '../runs/generation-run.entity';
import { CanvasDoc } from './canvas.entity';
import { CanvasService, LeaseProof } from './canvas.service';
import { activeInput, CanvasIoState, currentOutput, emptyCanvasIo, IoInputGroup, IoItem, IoSnapshot } from './canvas-io.types';

export interface InputFile { buffer: Buffer; originalname: string; mimetype: string; }
export const snapshot = (items: IoItem[], version: number, actorId: string, sourceOutputsVersion?: number): IoSnapshot => ({ id: randomUUID(), version, actorId, createdAt: new Date().toISOString(), items, ...(sourceOutputsVersion == null ? {} : { sourceOutputsVersion }) });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function invalid(message: string, code = 'VALIDATION_ERROR'): never { throw new BadRequestException({ code, message }); }

@Injectable()
export class CanvasIoService {
  constructor(private readonly canvas: CanvasService, private readonly assets: AssetsService, @InjectRepository(CanvasDoc) private readonly docs: Repository<CanvasDoc>) {}

  async get(id: string) { return (await this.canvas.findOne(id)).io ?? emptyCanvasIo(); }

  async preview(id: string, groupId: string) {
    const group = this.group(await this.get(id), groupId);
    if (!group.sourceCanvasId) return { available: false, message: '本地输入不监视原文件', changes: [] };
    const source = await this.docs.findOne({ where: { id: group.sourceCanvasId } });
    if (!source) return { available: false, message: '来源已删除，无法更新', changes: [] };
    const output = currentOutput(source.io ?? emptyCanvasIo());
    const items = output?.items ?? []; const before = activeInput(group);
    const changes = diffItems(before.items, items);
    return { available: true, sourceName: source.name, sourceOutputsVersion: output?.version ?? 0, previousVersion: before.sourceOutputsVersion, changes, hasUpdate: before.sourceOutputsVersion !== (output?.version ?? 0), items };
  }

  async importFiles(id: string, proof: LeaseProof, files: InputFile[], name?: string) {
    return this.assets.withReadProtection(id, () => this.importProtected(id, proof, files, name));
  }
  private async importProtected(id: string, proof: LeaseProof, files: InputFile[], name?: string) {
    if (!files?.length || files.length > 30) invalid('请选择 1–30 个文件');
    files = files.map(file => ({ ...file, originalname: normalizeFilename(file.originalname) }));
    const identity = { name: name ?? '', files: files.map(f => ({ name: f.originalname, hash: createHash('sha256').update(f.buffer).digest('hex') })) };
    const replay = await this.canvas.replayIo(id, proof, 'input.import', identity); if (replay) return replay;
    await this.canvas.assertWriteAccess(id, proof);
    const prepared: Asset[] = []; const items: IoItem[] = [];
    try {
      for (const file of files) {
        const kind = detectFile(file);
        const text = kind === 'text' ? decodeText(file.buffer) : undefined;
        const asset = await this.assets.prepareImport({ canvasId: id, buffer: file.buffer, kind, originName: file.originalname, mime: kind === 'text' ? 'text/plain; charset=utf-8' : file.mimetype });
        prepared.push(asset); items.push({ itemKey: randomUUID(), assetId: asset.id, kind, name: file.originalname, note: '', hash: createHash('sha256').update(file.buffer).digest('hex'), ...(text == null ? {} : { text }) });
      }
      const version = snapshot(items, 1, proof.actorId ?? '');
      return await this.canvas.applyIoCommand(id, proof, 'input.import', identity, async (draft, manager) => {
        await manager.getRepository(Asset).save(prepared); draft.io ??= emptyCanvasIo();
        draft.io.inputs.push({ id: randomUUID(), name: name?.trim() || files[0].originalname, note: '', sourceType: 'file', activeSnapshotId: version.id, snapshots: [version] });
      });
    } finally { await this.assets.discardPrepared(prepared); }
  }

  async command(id: string, proof: LeaseProof, command: string, payload: any = {}) {
    return this.assets.withReadProtection(id, () => this.commandProtected(id, proof, command, payload));
  }
  private async commandProtected(id: string, proof: LeaseProof, command: string, payload: any = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('payload 必须为对象');
    const replay = await this.canvas.replayIo(id, proof, command, payload); if (replay) return replay;
    const target = await this.canvas.assertWriteAccess(id, proof);
    if (command === 'input.capture' || command === 'input.update') return this.capture(id, proof, command, payload, target);
    const prepared: Asset[] = [];
    try {
      let published: IoItem | undefined; const batch: IoItem[] = [];
      if (command === 'output.publish' && payload.items !== undefined) {
        if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 100) invalid('请选择 1–100 个输出');
        for (const item of payload.items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('输出项不合法');
          batch.push(await this.publishedItem(id, target, item, prepared));
        }
      } else if (command === 'output.publish' || command === 'output.replace') published = await this.publishedItem(id, target, payload, prepared);
      return await this.canvas.applyIoCommand(id, proof, command, payload, async (draft, manager) => {
        draft.io ??= emptyCanvasIo(); const io = draft.io;
        if (prepared.length) await manager.getRepository(Asset).save(prepared);
        if (command.startsWith('output.')) {
          const items = clone(currentOutput(io)?.items ?? []);
          if (command === 'output.publish' || command === 'output.replace') {
            const used = new Set(items.filter(item => command !== 'output.replace' || item.itemKey !== payload.itemKey).map(item => item.assetId));
            for (const item of batch.length ? batch : [published!]) {
              if (used.has(item.assetId)) invalid('该资源已设为输出，不能重复设置', 'OUTPUT_ASSET_ALREADY_PUBLISHED');
              used.add(item.assetId);
            }
          }
          if (command === 'output.publish') items.push(...(batch.length ? batch : [published!]));
          else if (command === 'output.replace') { const index = items.findIndex(i => i.itemKey === payload.itemKey); if (index < 0) invalid('输出不存在'); items[index] = { ...published!, itemKey: items[index].itemKey }; }
          else if (command === 'output.edit') { const item = items.find(i => i.itemKey === payload.itemKey); if (!item) invalid('输出不存在'); item.name = bounded(payload.name, item.name); item.note = bounded(payload.note, item.note, 2000); }
          else if (command === 'output.remove') { const index = items.findIndex(i => i.itemKey === payload.itemKey); if (index < 0) invalid('输出不存在'); items.splice(index, 1); }
          else if (command === 'output.reorder') { if (!Array.isArray(payload.order) || payload.order.length !== items.length || new Set(payload.order).size !== items.length || payload.order.some((key: string) => !items.some(i => i.itemKey === key))) invalid('排序必须包含每个输出一次'); items.sort((a,b) => payload.order.indexOf(a.itemKey) - payload.order.indexOf(b.itemKey)); }
          else invalid('不支持该输出命令');
          io.outputs.push(snapshot(items, (currentOutput(io)?.version ?? 0) + 1, proof.actorId ?? ''));
        } else {
          const group = this.group(io, payload.groupId);
          if (command === 'input.restore') { if (!group.snapshots.some(s => s.id === payload.snapshotId)) invalid('快照不存在'); group.activeSnapshotId = payload.snapshotId; this.projectBindings(draft, group); }
          else if (command === 'input.remove') { if (draft.graph.nodes.some(n => n.data.inputGroupId === group.id)) invalid('请先删除该输入组的工作区节点', 'INPUT_ITEM_IN_USE'); io.inputs = io.inputs.filter(g => g.id !== group.id); }
          else if (command === 'input.edit') { group.name = bounded(payload.name, group.name); group.note = bounded(payload.note, group.note, 2000); }
          else if (command === 'input.bind') {
            const item = activeInput(group).items.find(i => i.itemKey === payload.itemKey); if (!item) invalid('输入项不存在');
            const position = payload.position ?? { x: 0, y: 0 }; if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) invalid('坐标不合法');
            draft.graph.nodes.push({ id: randomUUID(), type: 'result', position, data: { inputMode: true, inputGroupId: group.id, inputItemKey: item.itemKey, cardName: item.name, note: group.note, ...bindingData(group, item) } });
          } else invalid('不支持该输入命令');
        }
      });
    } finally { await this.assets.discardPrepared(prepared); }
  }

  private async capture(id: string, proof: LeaseProof, command: string, payload: any, target: CanvasDoc) {
    const group = command === 'input.update' ? this.group(target.io ?? emptyCanvasIo(), payload.groupId) : undefined;
    const sourceId = group?.sourceCanvasId ?? payload.sourceCanvasId;
    if (!sourceId || sourceId === id) invalid('请选择其他画布作为来源');
    return this.assets.withReadProtection(sourceId, async () => {
      const source = await this.canvas.findOne(sourceId);
      const output = currentOutput(source.io ?? emptyCanvasIo());
      if (!group && !output?.items.length) invalid('来源画布尚未发布输出', 'SOURCE_HAS_NO_OUTPUTS');
      const version = output?.version ?? 0;
      if (payload.sourceOutputsVersion != null && payload.sourceOutputsVersion !== version) throw new ConflictException({ code: 'SOURCE_VERSION_CHANGED', message: '来源输出已变化，请重新预览' });
      if (group && activeInput(group).sourceOutputsVersion === version) return { canvas: target, baseRevision: target.revision, resultRevision: target.revision, noOp: true };
      const prepared: Asset[] = []; const items: IoItem[] = [];
      try {
        for (const item of output?.items ?? []) {
          const copied = await this.assets.prepareCopy(id, item.assetId); prepared.push(copied.asset);
          if (copied.hash !== item.hash) invalid('来源文件校验失败', 'SNAPSHOT_COPY_FAILED');
          items.push({ ...clone(item), assetId: copied.asset.id, sourceCanvasId: sourceId, sourceCanvasName: source.name, sourceOutputId: item.itemKey, sourceOutputsVersion: version, sourceAssetId: item.assetId });
        }
        const captured = snapshot(items, (group?.snapshots.length ?? 0) + 1, proof.actorId ?? '', version);
        return await this.canvas.applyIoCommand(id, proof, command, payload, async (draft, manager) => {
          draft.io ??= emptyCanvasIo(); await manager.getRepository(Asset).save(prepared);
          if (group) { const current = this.group(draft.io, group.id); current.snapshots.push(captured); current.activeSnapshotId = captured.id; this.projectBindings(draft, current); }
          else draft.io.inputs.push({ id: randomUUID(), name: bounded(payload.name, source.name), note: '', sourceType: 'canvas', sourceCanvasId: sourceId, sourceCanvasName: source.name, activeSnapshotId: captured.id, snapshots: [captured] });
        });
      } finally { await this.assets.discardPrepared(prepared); }
    });
  }

  private group(io: CanvasIoState, id: string): IoInputGroup { const group = io.inputs.find(g => g.id === id); if (!group) throw new NotFoundException({ code: 'INPUT_NOT_FOUND', message: '输入组不存在' }); return group; }
  private projectBindings(draft: CanvasDoc, group: IoInputGroup) {
    for (const node of draft.graph.nodes.filter(n => n.data.inputGroupId === group.id)) {
      const item = activeInput(group).items.find(i => i.itemKey === node.data.inputItemKey);
      if (!item) invalid(`新版移除了工作区节点“${node.data.cardName ?? node.id}”正在使用的输入，请先删除该节点或保留旧版`, 'INPUT_ITEM_IN_USE');
      if (item.kind !== node.data.kind) invalid('输入类型已变化，请先解除工作区使用', 'INPUT_KIND_CHANGED');
      node.data = { ...node.data, ...bindingData(group, item) };
    }
  }

  private async publishedItem(id: string, target: CanvasDoc, payload: any, prepared: Asset[]): Promise<IoItem> {
    let text = payload.text; let assetId = payload.assetId; let nodeId = payload.nodeId; let runId = payload.runId;
    if (runId) {
      const run = await this.docs.manager.getRepository(GenerationRun).findOne({ where: { id: runId, canvasId: id } });
      if (!run || run.status !== 'succeeded') invalid('只能发布当前画布的成功产物');
      nodeId = run.nodeId;
      if (assetId) { if (!run.outputAssetIds.includes(assetId)) invalid('该资源不属于指定 Run'); }
      else text = payload.textPart ? run.outputParts?.[payload.textPart as 'positive' | 'negative'] : run.outputText;
    } else if (nodeId) {
      const node = target.graph.nodes.find(n => n.id === nodeId); if (!node) invalid('节点不存在');
      if (assetId) { if (!((node.data.lastAssets ?? []) as any[]).some(a => a.assetId === assetId)) invalid('该资源不是指定节点的当前产物'); }
      else text = payload.textPart ? (node.data.lastTextParts as any)?.[payload.textPart] : node.data.lastText;
    }
    if (assetId) {
      return this.assets.withReadProtection(id, async () => {
        const { asset, absPath } = await this.assets.read(assetId); if (asset.canvasId !== id) invalid('只能发布当前画布内的资源');
        return { itemKey: randomUUID(), assetId, kind: asset.kind, name: bounded(payload.name, asset.originName ?? '输出'), note: bounded(payload.note, '', 2000), hash: await this.assets.fileHash(absPath), sourceNodeId: nodeId ?? asset.nodeId ?? undefined, sourceRunId: runId, ...(asset.kind === 'text' ? { text: decodeText(await import('fs/promises').then(fs => fs.readFile(absPath))) } : {}) };
      });
    }
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 5 * 1024 * 1024) invalid('请选择有效文字或媒体产物（文字最大 5 MB）');
    const buffer = Buffer.from(text); const asset = await this.assets.prepareImport({ canvasId: id, kind: 'text', buffer, originName: `${bounded(payload.name, '文字输出')}.txt`, mime: 'text/plain; charset=utf-8' }); prepared.push(asset);
    return { itemKey: randomUUID(), assetId: asset.id, kind: 'text', text, name: bounded(payload.name, '文字输出'), note: bounded(payload.note, '', 2000), hash: createHash('sha256').update(buffer).digest('hex'), sourceNodeId: nodeId, sourceRunId: runId };
  }
}

export function bindingData(group: IoInputGroup, item: IoItem) {
  return { kind: item.kind, inputSnapshotId: group.activeSnapshotId, lastText: item.text ?? '', lastAssets: item.kind === 'text' ? [] : [{ assetId: item.assetId, kind: item.kind, url: `/api/assets/${item.assetId}`, filename: item.name }], inputLocalAssetId: item.assetId };
}
export function diffItems(before: IoItem[], after: IoItem[]) {
  const changes: Array<{ itemKey: string; name: string; change: string }> = [];
  for (const item of before) { const next = after.find(i => i.itemKey === item.itemKey); if (!next) changes.push({ itemKey: item.itemKey, name: item.name, change: '移除' }); else if (item.hash !== next.hash || item.kind !== next.kind) changes.push({ itemKey: item.itemKey, name: next.name, change: '替换' }); else if (item.name !== next.name || item.note !== next.note) changes.push({ itemKey: item.itemKey, name: next.name, change: '说明修改' }); }
  for (const item of after) if (!before.some(i => i.itemKey === item.itemKey)) changes.push({ itemKey: item.itemKey, name: item.name, change: '新增' });
  if (before.map(i => i.itemKey).join() !== after.map(i => i.itemKey).join() && !changes.length) changes.push({ itemKey: '', name: '输出顺序', change: '排序修改' });
  return changes;
}
export function bounded(value: unknown, fallback: string, max = 200): string { if (value == null) return fallback; if (typeof value !== 'string' || value.length > max) invalid(`文字必须不超过 ${max} 字符`); return (value as string).trim() || fallback; }
function decodeText(buffer: Buffer) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return invalid('文本文件必须为 UTF-8 编码', 'UNSUPPORTED_FILE'); } }
export function detectFile(file: InputFile): AssetKind {
  const b = file.buffer; const ext = file.originalname.split('.').pop()?.toLowerCase();
  if (['txt','md','json'].includes(ext ?? '')) { if (b.length > 5 * 1024 * 1024 || b.includes(0)) invalid('无效文本文件或超过 5 MB', 'UNSUPPORTED_FILE'); decodeText(b); return 'text'; }
  const start = b.subarray(0, 16); const ascii = start.toString('ascii');
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (b[0] === 255 && b[1] === 216 && b[2] === 255) || ascii.startsWith('GIF8') || (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP')) return 'image';
  if ((ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WAVE') || ascii.startsWith('fLaC') || ascii.startsWith('ID3') || (b[0] === 255 && (b[1] & 0xe0) === 0xe0) || (ascii.startsWith('OggS') && file.mimetype.startsWith('audio/'))) return 'audio';
  if (ascii.slice(4,8) === 'ftyp' || b.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return file.mimetype.startsWith('audio/') ? 'audio' : 'video';
  return invalid('支持 UTF-8 文本、PNG/JPEG/GIF/WebP、WAV/MP3/FLAC/Ogg、MP4/MOV/WebM；文件内容必须符合格式', 'UNSUPPORTED_FILE');
}
export function normalizeFilename(name: string): string {
  // Busboy decodes Content-Disposition parameters as latin1, while browsers send UTF-8.
  if ([...name].some(char => char.charCodeAt(0) > 255)) return name;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')); } catch { return name; }
}
