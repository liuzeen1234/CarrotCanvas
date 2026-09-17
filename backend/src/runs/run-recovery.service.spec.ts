import { DataSource, Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from '../canvas/canvas.entity';
import { CanvasService } from '../canvas/canvas.service';
import { Workflow } from '../workflows/workflow.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from './generation-run.entity';
import { RunRecoveryService } from './run-recovery.service';
import { RunsService } from './runs.service';
import { RunsController } from './runs.controller';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Run recovery (SQLite authorization and atomic persistence)', () => {
  let db: DataSource;
  let canvas: CanvasService;
  let service: RunRecoveryService;
  let runs: RunsService;
  let doc: CanvasDoc;
  let source: GenerationRun;
  let proof: any;
  let assets: any;
  const input = () => ({ ...proof, assetId: 'found', reason: '请求超时后找回', evidence: '提供方任务 xyz 的输出 found.png' });
  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true,
      entities: [CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow, Asset, GenerationRun, GenerationRunHandoff, GenerationCandidateGroup] });
    await db.initialize();
    assets = { ensureCanvasPartition: jest.fn(), read: jest.fn(async (id: string) => {
      const asset = await db.getRepository(Asset).findOneByOrFail({ id });
      return { asset, absPath: 'existing-file.png' };
    }) };
    canvas = new CanvasService(db.getRepository(CanvasDoc), db.getRepository(CanvasControlLease), db.getRepository(CanvasOperationReceipt), db.getRepository(CanvasOperationLog), db.getRepository(CanvasCheckpoint), db.getRepository(CanvasAssetGcJob), assets);
    runs = new RunsService(db.getRepository(GenerationRun), db.getRepository(GenerationRunHandoff), db.getRepository(GenerationCandidateGroup), db.getRepository(Asset));
    service = new RunRecoveryService(db.getRepository(GenerationRun), canvas, assets);
    doc = await canvas.create({ name: 'Recovery' });
    const lease = await canvas.acquire(doc.id, { holderType: 'human', holderId: 'human-recover' });
    proof = { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: 0 };
    await canvas.applyOperations(doc.id, { ...proof, idempotencyKey: 'create', operations: [{ type: 'create_node', node: {
      id: 'n1', type: 'codex-capability', position: { x: 0, y: 0 }, data: { capability: 'edit', prompt: 'original', model: 'codex', lastAssets: [{ assetId: 'found', url: '/api/assets/found', kind: 'image' }] },
    } }] });
    proof.expectedRevision = 1;
    source = (await runs.begin({ provider: 'codex2api', capabilityId: 'image-edit', canvasId: doc.id, nodeId: 'n1', inputSnapshot: { prompt: 'original' }, inputAssetIds: ['reference'], actorType: 'agent', actorId: 'original-agent' })).run;
    await runs.finish(source.id, 'failed', [], { message: 'timeout' });
    await db.getRepository(Asset).save({ id: 'found', canvasId: doc.id, nodeId: 'n1', kind: 'image', source: 'upload', relPath: 'upload/found.png' });
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.destroy(); });

  it('discovers current output and attributed notes without registering or claiming upstream success', async () => {
    const before = await canvas.findOne(doc.id);
    before.graph.nodes[0].data.note = `Run: ${source.id}；assetId: found；上游补录`;
    await db.getRepository(CanvasDoc).save(before);
    const draft = await service.suggest(source.id);
    expect(draft.assetId).toBe('found');
    expect(draft.reason).toContain('timeout');
    expect(draft.evidence).toContain('当前显示');
    expect(draft.evidence).toContain('节点备注');
    expect(draft.evidence).toContain('尚未核验');
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
    expect(await canvas.findOne(doc.id)).toEqual(before);
  });

  it('falls back to manual evidence when only asset ownership is known and rejects invalid assets', async () => {
    await db.getRepository(Asset).save({ id: 'other', canvasId: doc.id, nodeId: 'n1', kind: 'image', source: 'upload', relPath: 'upload/other.png' });
    expect((await service.suggest(source.id, 'other')).evidence).toBe('');
    await db.getRepository(Asset).update('other', { canvasId: 'foreign' });
    await expect(service.suggest(source.id, 'other')).rejects.toMatchObject({ response: { code: 'RECOVERY_ASSET_MISMATCH' } });
    const stored = await canvas.findOne(doc.id);
    stored.graph.nodes[0].data.lastAssets = [];
    await db.getRepository(CanvasDoc).save(stored);
    expect(await service.suggest(source.id)).toMatchObject({ assetId: '', evidence: '' });
  });

  it('uses provider correlation and reuses immutable recovery explanation for replay', async () => {
    await runs.patch(source.id, { providerRunId: 'provider-task' });
    await db.getRepository(Asset).update('found', { runPromptId: 'provider-task' });
    expect((await service.suggest(source.id, 'found')).evidence).toContain('任务 ID 一致');
    const result = await service.recover(source.id, input());
    expect(await service.suggest(source.id, 'found')).toMatchObject({ reason: result.run.recovery!.reason, evidence: result.run.recovery!.evidence });
  });

  it('keeps failure immutable and adds identifiable recovery/candidate/lineage without changing graph', async () => {
    const before = await canvas.findOne(doc.id);
    const result = await service.recover(source.id, input());
    expect(result.run).toMatchObject({ status: 'succeeded', parentRunId: source.id, providerRunId: null, actorType: 'human', actorId: 'human-recover', startedAt: null,
      recovery: { sourceRunId: source.id, sourceStatus: 'failed', reason: input().reason, evidence: input().evidence } });
    expect(await runs.get(source.id)).toMatchObject({ status: 'failed', error: { message: 'timeout' }, outputAssetIds: [] });
    expect(await runs.group(doc.id, 'n1')).toMatchObject({ candidateAssetIds: ['found'], selectedAssetId: 'found', selectedRunId: result.run.id });
    expect(await canvas.findOne(doc.id)).toEqual(before);
    expect((await runs.lineage(result.run.id)).parent?.id).toBe(source.id);
    expect((await runs.lineage(source.id)).children.map((run) => run.id)).toContain(result.run.id);
    expect((await runs.list({ nodeId: 'n1', status: 'succeeded' })).total).toBe(1);
    expect((await runs.list({ canvasId: doc.id, nodeId: 'n1', status: 'succeeded', includeRecoverable: 'true' })).recoverableRuns).toEqual([expect.objectContaining({ id: source.id, status: 'failed' })]);
    await expect(runs.retry(result.run.id, 'retry-recovery')).rejects.toMatchObject({ response: { code: 'RECOVERY_NOT_RETRYABLE' } });
    await runs.onModuleInit();
    expect((await runs.get(result.run.id)).recovery?.sourceRunId).toBe(source.id);
  });

  it('replays per source + asset, does not reset selection and rejects changed evidence', async () => {
    const first = await service.recover(source.id, input());
    await db.getRepository(GenerationCandidateGroup).update({ canvasId: doc.id }, { selectedAssetId: 'other', selectedRunId: 'other-run', approvedAssetId: 'other' });
    const second = await service.recover(source.id, input());
    expect(second).toMatchObject({ replay: true, run: { id: first.run.id } });
    expect((await runs.group(doc.id, 'n1'))?.selectedAssetId).toBe('other');
    expect(await db.getRepository(GenerationRun).count()).toBe(2);
    await expect(service.recover(source.id, { ...input(), evidence: 'different' })).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('preserves an existing current and approved version while appending a recovered candidate', async () => {
    await db.getRepository(GenerationCandidateGroup).save({ canvasId: doc.id, nodeId: 'n1', shotId: null, candidateAssetIds: ['approved'], selectedAssetId: 'approved', selectedRunId: 'old', approvedAssetId: 'approved' });
    await service.recover(source.id, input());
    expect(await runs.group(doc.id, 'n1')).toMatchObject({ candidateAssetIds: ['approved', 'found'], selectedAssetId: 'approved', selectedRunId: 'old', approvedAssetId: 'approved' });
  });

  it('deduplicates simultaneous registration and rejects recovery chaining or reuse for another original', async () => {
    const results = await Promise.all([service.recover(source.id, input()), service.recover(source.id, input())]);
    expect(new Set(results.map((item) => item.run.id)).size).toBe(1);
    expect(results.filter((item) => item.replay).length).toBe(1);
    await expect(service.recover(results[0].run.id, input())).rejects.toMatchObject({ response: { code: 'RUN_NOT_RECOVERABLE' } });
    const other = (await runs.begin({ provider: source.provider, capabilityId: source.capabilityId, canvasId: doc.id, nodeId: 'n1', inputSnapshot: {} })).run;
    await runs.finish(other.id, 'failed');
    await expect(service.recover(other.id, input())).rejects.toMatchObject({ response: { code: 'ASSET_ALREADY_RECORDED' } });
  });

  it('rejects missing/expired/stale leases and stale revisions without adding records', async () => {
    await expect(service.recover(source.id, { ...input(), leaseToken: '' })).rejects.toBeDefined();
    await expect(service.recover(source.id, { ...input(), leaseEpoch: 999 })).rejects.toMatchObject({ response: { code: 'STALE_LEASE' } });
    await expect(service.recover(source.id, { ...input(), expectedRevision: 0 })).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    await canvas.release(doc.id, proof);
    await expect(service.recover(source.id, input())).rejects.toBeDefined();
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
  });

  it('rejects cross-canvas, cross-node, wrong-type and input-reference assets', async () => {
    for (const patch of [{ canvasId: 'foreign' }, { nodeId: 'foreign' }, { kind: 'video' as const }]) {
      await db.getRepository(Asset).update('found', patch);
      await expect(service.recover(source.id, input())).rejects.toMatchObject({ response: { code: 'RECOVERY_ASSET_MISMATCH' } });
      await db.getRepository(Asset).update('found', { canvasId: doc.id, nodeId: 'n1', kind: 'image' });
    }
    await runs.patch(source.id, { inputAssetIds: ['found'] });
    await expect(service.recover(source.id, input())).rejects.toMatchObject({ response: { code: 'RECOVERY_ASSET_MISMATCH' } });
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
  });

  it('rejects absent files, empty evidence, successful/active/recovery sources and handoff-pending', async () => {
    assets.read.mockRejectedValueOnce(new Error('file missing'));
    await expect(service.recover(source.id, input())).rejects.toThrow('file missing');
    await expect(service.recover(source.id, { ...input(), evidence: ' ' })).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    for (const status of ['running', 'succeeded'] as const) {
      await runs.patch(source.id, { status });
      await expect(service.recover(source.id, input())).rejects.toMatchObject({ response: { code: 'RUN_NOT_RECOVERABLE' } });
    }
    await runs.patch(source.id, { status: 'failed' });
    await canvas.requestHandoff(doc.id, { holderType: 'agent', holderId: 'next' });
    await expect(service.recover(source.id, input())).rejects.toMatchObject({ response: { code: 'RECOVERY_HANDOFF_PENDING' } });
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
  });

  it('rolls back a recovered Run when appending the candidate fails', async () => {
    const originalSave = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function(this: Repository<any>, ...args: any[]) {
      if (this.metadata.target === GenerationCandidateGroup) throw new Error('candidate failure');
      return (originalSave as any).apply(this, args);
    } as any);
    await expect(service.recover(source.id, input())).rejects.toThrow('candidate failure');
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
    expect(await runs.group(doc.id, 'n1')).toBeNull();
  });

  it('exposes the recovery command and traceable history over the same HTTP controller', async () => {
    const module = await Test.createTestingModule({ controllers: [RunsController], providers: [
      { provide: RunsService, useValue: runs }, { provide: CanvasService, useValue: canvas }, { provide: RunRecoveryService, useValue: service },
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    try {
      await request(app.getHttpServer()).post(`/api/runs/${source.id}/recover`).send({ ...input(), leaseToken: '' }).expect(403);
      const registered = await request(app.getHttpServer()).post(`/api/runs/${source.id}/recover`).send(input()).expect(201);
      const replay = await request(app.getHttpServer()).post(`/api/runs/${source.id}/recover`).send(input()).expect(201);
      expect(replay.body).toMatchObject({ replay: true, run: { id: registered.body.run.id } });
      const history = await request(app.getHttpServer()).get(`/api/runs?canvasId=${doc.id}&nodeId=n1&status=succeeded&includeRecoverable=true`).expect(200);
      expect(history.body.items[0]).toMatchObject({ recovery: { sourceRunId: source.id }, outputAssetIds: ['found'] });
      const original = await request(app.getHttpServer()).get(`/api/runs/${source.id}`).expect(200);
      expect(original.body).toMatchObject({ status: 'failed', outputAssetIds: [] });
    } finally { await app.close(); }
  });

  it('migrates a byte-identical successful output to a replacement canvas without replacing its current candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'carrot-run-migration-'));
    try {
      const sourcePath = join(directory, 'source.wav');
      const targetPath = join(directory, 'target.wav');
      await writeFile(sourcePath, Buffer.from('same-wave-bytes'));
      await writeFile(targetPath, Buffer.from('different-wave-bytes'));
      const target = await canvas.create({ name: 'Replacement' });
      const targetLease = await canvas.acquire(target.id, { holderType: 'agent', holderId: 'migration-agent' });
      const targetProof = { leaseToken: targetLease.leaseToken, leaseEpoch: targetLease.epoch, expectedRevision: 0 };
      await canvas.applyOperations(target.id, { ...targetProof, idempotencyKey: 'target-node', operations: [{ type: 'create_node', node: {
        id: 'n1', type: 'codex-capability', position: { x: 0, y: 0 }, data: { capability: 'edit', prompt: 'migrated', model: 'codex', lastAssets: [{ assetId: 'current', url: '/api/assets/current', kind: 'image' }] },
      } }] });
      targetProof.expectedRevision = 1;
      await runs.patch(source.id, { status: 'succeeded', outputAssetIds: ['source-a'], error: null });
      await db.getRepository(Asset).save([
        { id: 'source-a', canvasId: doc.id, nodeId: 'n1', kind: 'image', source: 'generated', relPath: 'generated/source.wav' },
        { id: 'target-a', canvasId: target.id, nodeId: 'n1', kind: 'image', source: 'upload', relPath: 'upload/target.wav' },
        { id: 'current', canvasId: target.id, nodeId: 'n1', kind: 'image', source: 'generated', relPath: 'generated/current.png' },
      ]);
      await db.getRepository(GenerationCandidateGroup).save({ canvasId: target.id, nodeId: 'n1', shotId: null, candidateAssetIds: ['current'], selectedAssetId: 'current', selectedRunId: 'current-run', approvedAssetId: null });
      assets.read.mockImplementation(async (id: string) => {
        const asset = await db.getRepository(Asset).findOneByOrFail({ id });
        return { asset, absPath: id === 'source-a' ? sourcePath : targetPath };
      });
      const migrationInput = { ...targetProof, targetCanvasId: target.id, targetNodeId: 'n1', targetAssetId: 'target-a', sourceAssetId: 'source-a', reason: '拆分画布并保留原生成历史' };
      await expect(service.migrate(source.id, migrationInput)).rejects.toMatchObject({ response: { code: 'RUN_MIGRATION_CONTENT_MISMATCH' } });
      await writeFile(targetPath, Buffer.from('same-wave-bytes'));
      const migrated = await service.migrate(source.id, migrationInput);
      expect(migrated.run).toMatchObject({ status: 'succeeded', canvasId: target.id, nodeId: 'n1', parentRunId: source.id, outputAssetIds: ['target-a'], recovery: { kind: 'canvas_migration', sourceCanvasId: doc.id, sourceAssetId: 'source-a' } });
      expect((await runs.group(target.id, 'n1'))).toMatchObject({ candidateAssetIds: ['current', 'target-a'], selectedAssetId: 'current', selectedRunId: 'current-run' });
      expect((await service.migrate(source.id, migrationInput))).toMatchObject({ replay: true, run: { id: migrated.run.id } });
      expect(await runs.get(source.id)).toMatchObject({ canvasId: doc.id, status: 'succeeded', outputAssetIds: ['source-a'] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
