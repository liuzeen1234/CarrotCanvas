import { DataSource } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from '../canvas/canvas.entity';
import { CanvasService } from '../canvas/canvas.service';
import { Workflow } from '../workflows/workflow.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff, GenerationRunStatus } from './generation-run.entity';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

describe('Phase 1B run handoff (SQLite integration)', () => {
  let db: DataSource;
  let canvas: CanvasService;
  let runs: RunsService;
  let controller: RunsController;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow, Asset, GenerationRun, GenerationRunHandoff, GenerationCandidateGroup], synchronize: true });
    await db.initialize();
    const assets = { ensureCanvasPartition: jest.fn(), getCanvasAssetSizes: jest.fn(async () => ({})), deleteCanvas: jest.fn(), deleteGeneratedByNode: jest.fn() };
    canvas = new CanvasService(db.getRepository(CanvasDoc), db.getRepository(CanvasControlLease), db.getRepository(CanvasOperationReceipt), db.getRepository(CanvasOperationLog), db.getRepository(CanvasCheckpoint), db.getRepository(CanvasAssetGcJob), assets as any);
    runs = new RunsService(db.getRepository(GenerationRun), db.getRepository(GenerationRunHandoff), db.getRepository(GenerationCandidateGroup), db.getRepository(Asset));
    controller = new RunsController(runs, canvas);
  });

  afterEach(async () => { await db.destroy(); });

  const body = (lease: any, actorType: 'human' | 'agent', actorId: string, revision = 0) => ({ leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: revision, actorType, actorId });

  it.each<GenerationRunStatus>(['running', 'succeeded', 'failed', 'cancelled', 'needs_attention'])('AI → 人工交接 %s Run，保持双重 run ID 且旧 epoch 失效', async (status) => {
    const doc = await canvas.create({ name: status });
    const agentLease = await canvas.acquire(doc.id, { holderType: 'agent', holderId: 'agent-a' });
    const begun = await runs.begin({ provider: 'comfyui', canvasId: doc.id, nodeId: 'node-1', inputSnapshot: {}, actorType: 'agent', actorId: 'agent-a' });
    await runs.patch(begun.run.id, { status, providerRunId: `provider-${status}` });

    const handed = await controller.handoff(begun.run.id, { ...body(agentLease, 'agent', 'agent-a'), summary: '继续观察，不要重复提交' }) as { handoff: GenerationRunHandoff };
    const humanLease = await canvas.acquire(doc.id, { holderType: 'human', holderId: 'human-b' });
    const adopted = await controller.adopt(begun.run.id, body(humanLease, 'human', 'human-b'));

    expect(adopted.run.id).toBe(begun.run.id);
    expect(adopted.run.providerRunId).toBe(`provider-${status}`);
    expect(adopted.handoff.id).toBe(handed.handoff.id);
    expect((await canvas.findOne(doc.id)).lastHandoffId).toBe(handed.handoff.id);
    await expect(canvas.assertWriteAccess(doc.id, body(agentLease, 'agent', 'agent-a'))).rejects.toMatchObject({ status: 409 });
  });

  it('人工 → AI 双向接手不创建新 Run，重复 adopt 幂等', async () => {
    const doc = await canvas.create({ name: 'human-to-agent' });
    const humanLease = await canvas.acquire(doc.id, { holderType: 'human', holderId: 'human-a' });
    const begun = await runs.begin({ provider: 'codex2api', canvasId: doc.id, inputSnapshot: {}, actorType: 'human', actorId: 'human-a', providerRunId: 'codex-request-1' });
    await controller.handoff(begun.run.id, body(humanLease, 'human', 'human-a'));
    const agentLease = await canvas.acquire(doc.id, { holderType: 'agent', holderId: 'agent-b' });
    const first = await controller.adopt(begun.run.id, body(agentLease, 'agent', 'agent-b'));
    const replay = await controller.adopt(begun.run.id, body(agentLease, 'agent', 'agent-b'));
    expect(first.run.id).toBe(begun.run.id);
    expect(first.run.providerRunId).toBe('codex-request-1');
    expect(replay.replay).toBe(true);
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
  });

  it('交接身份必须与租约持有者一致', async () => {
    const doc = await canvas.create({ name: 'identity' });
    const lease = await canvas.acquire(doc.id, { holderType: 'agent', holderId: 'agent-a' });
    const run = (await runs.begin({ provider: 'comfyui', canvasId: doc.id, inputSnapshot: {} })).run;
    await expect(controller.handoff(run.id, body(lease, 'agent', 'spoofed'))).rejects.toMatchObject({ status: 403 });
  });
});
