import { DataSource } from 'typeorm';
import { CanvasControlLease, CanvasDoc, CanvasOperationReceipt, emptyCanvasGraph } from './canvas.entity';
import { CanvasService } from './canvas.service';

describe('Phase 0A canvas control (SQLite integration)', () => {
  let db: DataSource;
  let service: CanvasService;
  let docs: any;
  let leases: any;
  let receipts: any;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [CanvasDoc, CanvasControlLease, CanvasOperationReceipt], synchronize: true });
    await db.initialize();
    docs = db.getRepository(CanvasDoc); leases = db.getRepository(CanvasControlLease); receipts = db.getRepository(CanvasOperationReceipt);
    service = new CanvasService(docs, leases, receipts, { ensureCanvasPartition: jest.fn(), getCanvasAssetSizes: jest.fn(async () => ({})), deleteCanvas: jest.fn() } as any);
  });

  afterEach(async () => { await db.destroy(); });

  const create = () => service.create({ name: '0A 验收' });
  const proof = (lease: any, revision = 0, key = 'op-1') => ({ leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: revision, idempotencyKey: key, actorType: 'agent' as const, actorId: lease.holderId });
  const leaseProof = (lease: any) => ({ leaseToken: lease.leaseToken, leaseEpoch: lease.epoch });

  it('单写者、交接、新 epoch 和旧 lease 拒绝', async () => {
    const canvas = await create();
    const first = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'agent-a' });
    await expect(service.acquire(canvas.id, { holderType: 'human', holderId: 'human-b' })).rejects.toMatchObject({ status: 423 });
    await service.requestHandoff(canvas.id, { holderType: 'human', holderId: 'human-b' });
    expect((await service.renew(canvas.id, leaseProof(first))).status).toBe('handoff_pending');
    await service.release(canvas.id, leaseProof(first));
    const second = await service.acquire(canvas.id, { holderType: 'human', holderId: 'human-b' });
    expect(second.epoch).toBe(first.epoch + 1);
    await expect(service.renew(canvas.id, leaseProof(first))).rejects.toMatchObject({ status: 409 });
  });

  it('TTL/进程实例失效后允许新持有者取得控制权', async () => {
    const canvas = await create();
    await service.acquire(canvas.id, { holderType: 'agent', holderId: 'lost-agent' });
    const row = await leases.findOneByOrFail({ canvasId: canvas.id });
    row.expiresAt = new Date(Date.now() - 1); await leases.save(row);
    const replacement = await service.acquire(canvas.id, { holderType: 'human', holderId: 'recovery-human' });
    expect(replacement.epoch).toBe(2);
    row.status = 'active'; row.expiresAt = new Date(Date.now() + 60000); row.serverInstanceId = 'old-process'; await leases.save(row);
    expect((await service.controlStatus(canvas.id)).status).toBe('expired');
  });

  it('revision、幂等重放和 operation batch 一次递增', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'agent-a' });
    const dto = { ...proof(lease), operations: [{ type: 'rename_canvas' as const, name: '新名称' }, { type: 'set_brief' as const, brief: { goal: 'test' } }] };
    const first = await service.applyOperations(canvas.id, dto); const replay = await service.applyOperations(canvas.id, dto);
    expect(first.resultRevision).toBe(1); expect(replay.replayed).toBe(true); expect(replay.resultRevision).toBe(1);
    expect((await service.findOne(canvas.id)).revision).toBe(1);
    await expect(service.applyOperations(canvas.id, { ...dto, idempotencyKey: 'stale', operations: [{ type: 'set_brief', brief: null }] })).rejects.toMatchObject({ status: 409 });
  });

  it('非法 batch 和回执写入失败都不留下部分状态或 revision', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'agent-a' });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 0, 'invalid'), operations: [{ type: 'rename_canvas', name: '不应保留' }, { type: 'replace_graph', graph: { version: 1, nodes: [], edges: 'bad' as any, viewport: null } }] })).rejects.toBeDefined();
    expect(await service.findOne(canvas.id)).toMatchObject({ name: '0A 验收', revision: 0 });
    await db.query("CREATE TRIGGER fail_receipt BEFORE INSERT ON canvas_operation_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 0, 'rollback'), operations: [{ type: 'rename_canvas', name: '也不应保留' }] })).rejects.toThrow('injected receipt failure');
    await db.query('DROP TRIGGER fail_receipt');
    expect(await service.findOne(canvas.id)).toMatchObject({ name: '0A 验收', revision: 0 });
  });

  it('人工强制接管要求原因、记录原因并增加 epoch', async () => {
    const canvas = await create(); await service.acquire(canvas.id, { holderType: 'agent', holderId: 'lost-agent' });
    await expect(service.forceTakeover(canvas.id, { holderType: 'human', holderId: 'human', reason: '' })).rejects.toBeDefined();
    const takeover = await service.forceTakeover(canvas.id, { holderType: 'human', holderId: 'human', reason: '控制者失联' });
    expect(takeover.epoch).toBe(2);
    expect((await service.controlStatus(canvas.id)).lease?.lastTakeoverReason).toBe('控制者失联');
  });
});
