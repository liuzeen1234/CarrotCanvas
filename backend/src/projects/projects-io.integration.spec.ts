import { DataSource } from 'typeorm';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Asset } from '../assets/asset.entity';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from '../canvas/canvas.entity';
import { Workflow } from '../workflows/workflow.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from '../runs/generation-run.entity';
import { Project, ProjectCanvas, ProjectReceipt } from './project.entity';

describe('Projects and independent canvas IO snapshots (SQLite + real files)', () => {
  let root: string; let db: DataSource; let assets: any; let canvas: any; let io: any; let projects: any; let runs: any;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'carrot-project-io-')); process.env.CARROT_ASSETS_ROOT = root; });
  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Asset, CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow, GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Project, ProjectCanvas, ProjectReceipt], synchronize: true }); await db.initialize();
    const { AssetsService } = require('../assets/assets.service'); const { CanvasService } = require('../canvas/canvas.service'); const { CanvasIoService } = require('../canvas/canvas-io.service'); const { ProjectsService } = require('./projects.service'); const { RunsService } = require('../runs/runs.service');
    assets = new AssetsService(db.getRepository(Asset), db.getRepository(CanvasCheckpoint), db.getRepository(GenerationCandidateGroup));
    canvas = new CanvasService(db.getRepository(CanvasDoc), db.getRepository(CanvasControlLease), db.getRepository(CanvasOperationReceipt), db.getRepository(CanvasOperationLog), db.getRepository(CanvasCheckpoint), db.getRepository(CanvasAssetGcJob), assets);
    io = new CanvasIoService(canvas, assets, db.getRepository(CanvasDoc)); projects = new ProjectsService(db.getRepository(Project), assets, canvas);
    runs = new RunsService(db.getRepository(GenerationRun), db.getRepository(GenerationRunHandoff), db.getRepository(GenerationCandidateGroup), db.getRepository(Asset));
  });
  afterEach(async () => { await db.destroy(); });
  afterAll(async () => { delete process.env.CARROT_ASSETS_ROOT; await rm(root, { recursive: true, force: true }); });
  const make = async (name = '画布') => { const doc = await canvas.create({ name }); const lease = await canvas.acquire(doc.id, { holderType: 'agent', holderId: `test-${doc.id}` }); return { id: doc.id, lease }; };
  const proof = async (c: any, key: string = randomUUID()) => ({ leaseToken: c.lease.leaseToken, leaseEpoch: c.lease.epoch, expectedRevision: (await canvas.findOne(c.id)).revision, idempotencyKey: key, actorType: 'agent', actorId: c.lease.holderId });
  const command = async (c: any, name: string, payload: any) => io.command(c.id, await proof(c), name, payload);
  const pc = async (p: any, command: string, payload: any = {}) => projects.command(p.id, { expectedRevision: (await projects.get(p.id)).revision, idempotencyKey: randomUUID(), command, payload });
  const output = async (c: any) => (await io.get(c.id)).outputs.at(-1);

  it('rejects duplicate output assets across single, batch and replacement requests without adding a revision', async () => {
    const c = await make(); await command(c, 'output.publish', { text: 'A' }); await command(c, 'output.publish', { text: 'B' });
    const [a,b] = (await output(c)).items; const before = (await canvas.findOne(c.id)).revision;
    for (const [name,payload] of [['output.publish',{assetId:a.assetId}],['output.publish',{items:[{text:'rollback'},{assetId:a.assetId}]}],['output.replace',{itemKey:b.itemKey,assetId:a.assetId}]] as any[]) {
      await expect(command(c,name,payload)).rejects.toMatchObject({response:{code:'OUTPUT_ASSET_ALREADY_PUBLISHED'}});
      expect((await canvas.findOne(c.id)).revision).toBe(before);
    }
    await command(c,'output.remove',{itemKey:a.itemKey});
    await expect(command(c,'output.publish',{items:[{assetId:a.assetId},{assetId:a.assetId}]})).rejects.toMatchObject({response:{code:'OUTPUT_ASSET_ALREADY_PUBLISHED'}});
    await command(c,'output.publish',{assetId:a.assetId}); expect((await output(c)).items).toHaveLength(2);
  });

  it('batch output publish commits one version and revision, replays once, and rolls back all items on failure', async () => {
    const c = await make(); const dto = await proof(c, 'batch-publish');
    const items = [{ text: '第一项', name: '说明一' }, { text: '第二项', name: '说明二', note: '批量发布' }];
    await io.command(c.id, dto, 'output.publish', { items });
    expect((await output(c)).items.map((i: any) => i.name)).toEqual(['说明一', '说明二']);
    expect((await io.get(c.id)).outputs).toHaveLength(1); expect((await canvas.findOne(c.id)).revision).toBe(1);
    await io.command(c.id, dto, 'output.publish', { items });
    expect((await output(c)).items).toHaveLength(2); expect(await db.getRepository(Asset).count()).toBe(2);
    await expect(command(c, 'output.publish', { items: [{ text: '不可留下的暂存文字' }, { assetId: randomUUID() }] })).rejects.toThrow();
    expect((await canvas.findOne(c.id)).revision).toBe(1); expect(await db.getRepository(Asset).count()).toBe(2);
    await expect(command(c, 'output.publish', { items: [] })).rejects.toThrow();
    expect((await io.get(c.id)).outputs).toHaveLength(1);
  });

  it('one canvas belongs to multiple project collections without acquiring its lease or changing canvas revision', async () => {
    const c = await make(); const a = await projects.create({ name: 'A' }); const b = await projects.create({ name: 'B' });
    await pc(a, 'canvas.add', { canvasId: c.id }); await pc(b, 'canvas.add', { canvasId: c.id }); await pc(a, 'canvas.add', { canvasId: c.id });
    expect((await canvas.findOne(c.id)).revision).toBe(0); expect((await canvas.list())[0].projects).toHaveLength(2);
    await pc(a, 'canvas.remove', { canvasId: c.id }); expect((await projects.get(b.id)).canvases).toHaveLength(1);
    await expect(projects.remove(b.id, (await projects.get(b.id)).revision)).rejects.toMatchObject({ response: { code: 'PROJECT_NOT_EMPTY' } });
    await projects.remove(a.id, (await projects.get(a.id)).revision); expect(await canvas.findOne(c.id)).toBeDefined();
  });
  it('project creation command creates a canvas and relation atomically and replays only once', async () => {
    const p = await projects.create({}); const dto = { expectedRevision: 0, idempotencyKey: 'create-canvas', command: 'canvas.create', payload: { name: '项目内新建' } };
    const first = await projects.command(p.id, dto); const second = await projects.command(p.id, dto);
    expect(first.createdCanvasId).toBe(second.createdCanvasId); expect((await projects.get(p.id)).canvases).toHaveLength(1);
    await expect(projects.command(p.id, { ...dto, payload: { name: 'different' } })).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('concurrent association changes cannot share SQLite savepoints or leave dangling links', async () => {
    const c = await make(); const a = await projects.create({}); const b = await projects.create({});
    await Promise.all([pc(a,'canvas.add',{canvasId:c.id}), pc(b,'canvas.add',{canvasId:c.id})]); expect((await canvas.list())[0].projects).toHaveLength(2);
    const revision = (await projects.get(a.id)).revision;
    const attempts = await Promise.allSettled([projects.command(a.id,{expectedRevision:revision,idempotencyKey:'remove-1',command:'canvas.remove',payload:{canvasId:c.id}}), projects.command(a.id,{expectedRevision:revision,idempotencyKey:'edit-2',command:'edit',payload:{name:'new'}})]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await projects.get(a.id)).revision).toBe(revision+1);
  });
  it('cross-project capture owns independent file bytes and survives source deletion, with receipt replay', async () => {
    const a = await make('来源'); const b = await make('下游'); await command(a, 'output.publish', { text: '旧文字', name: '人物' });
    const request = await proof(b); const payload = { sourceCanvasId: a.id }; const first = await io.command(b.id, request, 'input.capture', payload); const group = first.canvas.io.inputs[0]; const local = group.snapshots[0].items[0]; const source = (await output(a)).items[0];
    expect(local.assetId).not.toBe(source.assetId); expect((await assets.read(local.assetId)).asset.canvasId).toBe(b.id);
    await canvas.remove(a.id, await proof(a)); expect(await readFile((await assets.read(local.assetId)).absPath, 'utf8')).toBe('旧文字');
    expect((await io.preview(b.id, group.id)).available).toBe(false); expect((await io.command(b.id, request, 'input.capture', payload)).replayed).toBe(true);
  });
  it('explicit update makes a new version, preserves bindings and old run inputs, and supports rollback', async () => {
    const a = await make(); const b = await make(); await command(a, 'output.publish', { text: '第一版' });
    await command(b, 'input.capture', { sourceCanvasId: a.id }); let group = (await io.get(b.id)).inputs[0]; const old = group.snapshots[0];
    await command(b, 'input.bind', { groupId: group.id, itemKey: old.items[0].itemKey });
    const bound = (await canvas.findOne(b.id)).graph.nodes[0];
    const run = (await runs.begin({ provider: 'codex2api', canvasId: b.id, nodeId: bound.id, inputSnapshot: { actualText: bound.data.lastText }, actorType: 'agent' })).run;
    expect(run.inputLineage[0].snapshotId).toBe(old.id);
    await command(a, 'output.replace', { itemKey: (await output(a)).items[0].itemKey, text: '第二版' });
    expect((await canvas.findOne(b.id)).graph.nodes[0].data.lastText).toBe('第一版');
    const preview = await io.preview(b.id, group.id); expect(preview.changes[0].change).toBe('替换');
    await command(b, 'input.update', { groupId: group.id, sourceOutputsVersion: preview.sourceOutputsVersion }); group = (await io.get(b.id)).inputs[0];
    expect(group.snapshots).toHaveLength(2); expect((await canvas.findOne(b.id)).graph.nodes[0].data.lastText).toBe('第二版'); expect((await runs.get(run.id)).inputSnapshot).toEqual({ actualText: '第一版' });
    expect((await runs.get(run.id)).inputLineage[0].snapshotId).toBe(old.id);
    await command(b, 'input.restore', { groupId: group.id, snapshotId: old.id }); expect((await canvas.findOne(b.id)).graph.nodes[0].data.lastText).toBe('第一版');
  });
  it('removed or changed-type output in use cannot silently break the target graph', async () => {
    const a = await make(); const b = await make(); await command(a, 'output.publish', { text: 'reference' }); await command(b, 'input.capture', { sourceCanvasId: a.id }); const group = (await io.get(b.id)).inputs[0];
    await command(b, 'input.bind', { groupId: group.id, itemKey: group.snapshots[0].items[0].itemKey }); await command(a, 'output.remove', { itemKey: (await output(a)).items[0].itemKey });
    await expect(command(b, 'input.update', { groupId: group.id })).rejects.toMatchObject({ response: { code: 'INPUT_ITEM_IN_USE' } }); expect((await io.get(b.id)).inputs[0].snapshots).toHaveLength(1);
    await expect(command(b, 'input.remove', { groupId: group.id })).rejects.toMatchObject({ response: { code: 'INPUT_ITEM_IN_USE' } });
    const node = (await canvas.findOne(b.id)).graph.nodes[0]; await expect(canvas.applyOperations(b.id, { ...await proof(b), operations: [{ type: 'update_node', nodeId: node.id, dataPatch: { lastText: 'tamper' } }] })).rejects.toMatchObject({ response: { code: 'INPUT_BINDING_MISMATCH' } });
  });
  it('no-op update does not add a revision and source version race is rejected', async () => {
    const a = await make(); const b = await make(); await command(a, 'output.publish', { text: 'v1' }); await command(b, 'input.capture', { sourceCanvasId: a.id }); const group = (await io.get(b.id)).inputs[0]; const revision = (await canvas.findOne(b.id)).revision;
    expect((await command(b, 'input.update', { groupId: group.id })).noOp).toBe(true); expect((await canvas.findOne(b.id)).revision).toBe(revision);
    await command(a, 'output.publish', { text: 'v2' }); await expect(command(b, 'input.update', { groupId: group.id, sourceOutputsVersion: 1 })).rejects.toMatchObject({ response: { code: 'SOURCE_VERSION_CHANGED' } });
  });
  it('project results collect only associated outputs into independent files and survive unlink/delete', async () => {
    const a = await make('人物'); const p = await projects.create({}); await command(a, 'output.publish', { text: '交付' }); const out = await output(a); const selection = { canvasId: a.id, itemKey: out.items[0].itemKey, outputsVersion: out.version };
    await expect(pc(p, 'results.capture', { selections: [selection] })).rejects.toMatchObject({ response: { code: 'CANVAS_NOT_IN_PROJECT' } });
    await pc(p, 'canvas.add', { canvasId: a.id }); await pc(p, 'results.capture', { name: '交付一版', selections: [selection] }); const item = (await projects.get(p.id)).results[0].items[0];
    expect(item.assetId).not.toBe(out.items[0].assetId); await pc(p, 'canvas.remove', { canvasId: a.id }); await canvas.remove(a.id, await proof(a)); expect(await readFile((await assets.read(item.assetId)).absPath, 'utf8')).toBe('交付');
    const target = await make(); await expect(command(target, 'input.capture', { sourceCanvasId: p.id })).rejects.toMatchObject({ status: 404 });
    await projects.remove(p.id, (await projects.get(p.id)).revision); await expect(assets.read(item.assetId)).rejects.toMatchObject({ status: 404 });
  });
  it('deleting a canvas cleans all project links without deleting project snapshots', async () => {
    const c = await make(); const a = await projects.create({}); const b = await projects.create({}); await pc(a,'canvas.add',{canvasId:c.id}); await pc(b,'canvas.add',{canvasId:c.id});
    await canvas.remove(c.id, await proof(c)); expect((await projects.get(a.id)).canvases).toHaveLength(0); expect((await projects.get(b.id)).canvases).toHaveLength(0);
  });
  it('file import validates UTF-8 and preserves bytes; partial validation failure commits no input/assets', async () => {
    const c = await make(); const files = [{ originalname: '说明.md', mimetype: 'text/plain', buffer: Buffer.from('完整的说明') }]; await io.importFiles(c.id, await proof(c), files);
    const item = (await io.get(c.id)).inputs[0].snapshots[0].items[0]; expect(await readFile((await assets.read(item.assetId)).absPath)).toEqual(files[0].buffer);
    const count = await db.getRepository(Asset).count(); await expect(io.importFiles(c.id, await proof(c), [...files, { originalname: 'bad.txt', mimetype: 'text/plain', buffer: Buffer.from([0xff]) }])).rejects.toMatchObject({ response: { code: 'UNSUPPORTED_FILE' } }); expect(await db.getRepository(Asset).count()).toBe(count); expect((await io.get(c.id)).inputs).toHaveLength(1);
  });
  it('browser multipart UTF-8 Chinese filenames survive latin1 header decoding', async () => {
    const c = await make(); const name = '中文文件.md'; await io.importFiles(c.id, await proof(c), [{ originalname: Buffer.from(name).toString('latin1'), mimetype: 'text/plain', buffer: Buffer.from('内容') }]);
    const item = (await io.get(c.id)).inputs[0].snapshots[0].items[0]; expect(item.name).toBe(name); expect((await assets.read(item.assetId)).asset.originName).toBe(name);
  });
  it('checkpoint/undo include IO while output version remains monotonic', async () => {
    const c = await make(); await command(c,'output.publish',{text:'旧'}); const point = await canvas.createCheckpoint(c.id,{...await proof(c),name:'IO checkpoint'}); await command(c,'output.publish',{text:'新'});
    await canvas.restoreCheckpoint(c.id,point.id,await proof(c)); expect((await output(c)).items).toHaveLength(1); expect((await output(c)).version).toBe(3);
    await command(c,'output.edit',{itemKey:(await output(c)).items[0].itemKey,name:'改名'}); const log = (await canvas.operationLog(c.id))[0]; await canvas.undoOperation(c.id,log.id,await proof(c)); expect((await output(c)).items[0].name).not.toBe('改名'); expect((await output(c)).version).toBe(5);
  });
  it('published generated assets survive node cleanup and read pin prevents source deletion', async () => {
    const c = await make(); const asset = await assets.saveGenerated({ canvasId: c.id, nodeId: 'n', buffer: Buffer.from('bytes') }); await command(c,'output.publish',{assetId:asset.id}); await assets.deleteGeneratedByNode(c.id,'n'); expect(await assets.read(asset.id)).toBeDefined();
    await assets.withReadProtection(c.id, async () => { await expect(canvas.remove(c.id,await proof(c))).rejects.toMatchObject({ response: { code: 'SOURCE_COPY_IN_PROGRESS' } }); }); expect(await canvas.findOne(c.id)).toBeDefined();
  });
  it('receipt persistence failure rolls back graph/IO/revision and new Asset rows', async () => {
    const c = await make(); const prototype = Object.getPrototypeOf(db.getRepository(CanvasOperationReceipt)); const original = prototype.save;
    const spy = jest.spyOn(prototype,'save').mockImplementation(function(this:any,...args:any[]) { if (this.metadata.target === CanvasOperationReceipt) throw new Error('receipt failure'); return original.apply(this,args); });
    try { await expect(command(c,'output.publish',{text:'uncommitted'})).rejects.toThrow('receipt failure'); } finally { spy.mockRestore(); }
    expect((await canvas.findOne(c.id)).revision).toBe(0); expect((await io.get(c.id)).outputs).toHaveLength(0); expect(await db.getRepository(Asset).count()).toBe(0);
  });
  it('lease loss while copying cannot commit a new snapshot', async () => {
    const a = await make(); const b = await make(); await command(a,'output.publish',{text:'source'});
    const original = assets.prepareCopy.bind(assets); const spy = jest.spyOn(assets,'prepareCopy').mockImplementation(async (...args:any[]) => {
      const copied = await original(...args); await db.getRepository(CanvasControlLease).increment({canvasId:b.id},'epoch',1); return copied;
    });
    try { await expect(command(b,'input.capture',{sourceCanvasId:a.id})).rejects.toMatchObject({response:{code:'STALE_LEASE'}}); } finally { spy.mockRestore(); }
    expect((await io.get(b.id)).inputs).toHaveLength(0); expect((await canvas.findOne(b.id)).revision).toBe(0); expect(await db.getRepository(Asset).count({where:{canvasId:b.id}})).toBe(0);
  });
  it('canonical deletion and links commit before file cleanup; failed cleanup retries from persistent GC', async () => {
    const c = await make(); const p = await projects.create({}); await pc(p,'canvas.add',{canvasId:c.id}); await command(c,'output.publish',{text:'cleanup'});
    const spy = jest.spyOn(assets,'deleteCanvas').mockRejectedValueOnce(new Error('file busy')); await canvas.remove(c.id,await proof(c)); spy.mockRestore();
    await expect(canvas.findOne(c.id)).rejects.toMatchObject({status:404}); expect((await projects.get(p.id)).canvases).toHaveLength(0); expect(await db.getRepository(CanvasAssetGcJob).count({where:{canvasId:c.id}})).toBe(1);
    await canvas.onModuleInit(); expect(await db.getRepository(CanvasAssetGcJob).count({where:{canvasId:c.id}})).toBe(0);
  });
});
