import { DataSource } from 'typeorm';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt, emptyCanvasGraph } from './canvas.entity';
import { CanvasService } from './canvas.service';
import { Workflow } from '../workflows/workflow.entity';
import { AgentLeaseGuard } from './agent-lease-guard';

describe('Phase 0A canvas control (SQLite integration)', () => {
  let db: DataSource;
  let service: CanvasService;
  let docs: any;
  let leases: any;
  let receipts: any;
  let assets: any;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow], synchronize: true });
    await db.initialize();
    docs = db.getRepository(CanvasDoc); leases = db.getRepository(CanvasControlLease); receipts = db.getRepository(CanvasOperationReceipt);
    assets = { ensureCanvasPartition: jest.fn(), getCanvasAssetSizes: jest.fn(async () => ({})), deleteCanvas: jest.fn(), deleteGeneratedByNode: jest.fn() };
    service = new CanvasService(docs, leases, receipts, db.getRepository(CanvasOperationLog), db.getRepository(CanvasCheckpoint), db.getRepository(CanvasAssetGcJob), assets as any);
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

  it('AI 守护器在一个 heartbeat 内响应人工交接并主动释放', async () => {
    const canvas = await create();
    const guard = new AgentLeaseGuard({
      canvasId: canvas.id,
      holderId: 'guarded-agent',
      heartbeatMs: 60_000,
      transport: {
        acquire: async (canvasId, holderId) => {
          const current = await service.acquire(canvasId, { holderType: 'agent', holderId });
          return { leaseToken: current.leaseToken, epoch: current.epoch, status: current.status as 'active' | 'handoff_pending', revision: current.revision };
        },
        renew: async (canvasId, current) => {
          const renewed = await service.renew(canvasId, { leaseToken: current.leaseToken, leaseEpoch: current.epoch });
          return { leaseToken: renewed.leaseToken, epoch: renewed.epoch, status: renewed.status as 'active' | 'handoff_pending' };
        },
        release: async (canvasId, current) => { await service.release(canvasId, { leaseToken: current.leaseToken, leaseEpoch: current.epoch }); },
      },
    });
    const agentLease = await guard.start();
    await service.requestHandoff(canvas.id, { holderType: 'human', holderId: 'waiting-human' });

    await guard.heartbeatNow();

    expect(guard.state).toBe('released');
    expect((await service.controlStatus(canvas.id)).status).toBe('revoked');
    const humanLease = await service.acquire(canvas.id, { holderType: 'human', holderId: 'waiting-human' });
    expect(humanLease.epoch).toBe(agentLease.epoch + 1);
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

  it('0B 语义节点编排、日志和 inverse undo', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'agent-0b' });
    const generator = { id: 'gen', type: 'txt2img' as const, position: { x: 10, y: 20 }, data: { workflowId: 'wf', formValues: { prompt: '兔子' } } };
    const result = { id: 'out', type: 'result' as const, position: { x: 400, y: 20 }, data: { kind: 'image' } };
    const first = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'compose'), intent: '搭建文生图流程', operations: [
      { type: 'create_node', node: generator }, { type: 'create_node', node: result },
      { type: 'connect', edge: { id: 'e1', source: 'gen', sourceHandle: 'image-source', target: 'out', targetHandle: 'image-target' } },
      { type: 'move_nodes', positions: [{ nodeId: 'out', position: { x: 500, y: 40 } }] },
    ] });
    expect(first.canvas.graph).toMatchObject({ nodes: [{ id: 'gen' }, { id: 'out', position: { x: 500, y: 40 } }], edges: [{ id: 'e1' }] });
    const logs = await service.operationLog(canvas.id); expect(logs[0]).toMatchObject({ baseRevision: 0, resultRevision: 1, actorId: 'agent-0b', intent: '搭建文生图流程' });
    const undone = await service.undoOperation(canvas.id, logs[0].id, { ...proof(lease, 1, 'undo-compose') });
    expect(undone.canvas.graph).toEqual(emptyCanvasGraph());
  });

  it.each([
    ['重复节点', [{ type: 'create_node', node: { id: 'n', type: 'result', position: { x: 0, y: 0 }, data: {} } }, { type: 'create_node', node: { id: 'n', type: 'result', position: { x: 1, y: 1 }, data: {} } }], 'DUPLICATE_NODE_ID'],
    ['媒体类型', [{ type: 'replace_graph', graph: { version: 1, viewport: null, nodes: [{ id: 'a', type: 'codex-capability', position: { x: 0, y: 0 }, data: { capability: 'text', prompt: '', model: 'codex' } }, { id: 'b', type: 'result', position: { x: 1, y: 1 }, data: { kind: 'image' } }], edges: [{ id: 'e', source: 'a', sourceHandle: 'text-source', target: 'b', targetHandle: 'image-target' }] } }], 'MEDIA_TYPE_MISMATCH'],
    ['缺失节点', [{ type: 'replace_graph', graph: { version: 1, viewport: null, nodes: [], edges: [{ id: 'e', source: 'missing-a', sourceHandle: 'image-source', target: 'missing-b', targetHandle: 'image-target' }] } }], 'EDGE_NODE_NOT_FOUND'],
    ['单输入多入线', [{ type: 'replace_graph', graph: { version: 1, viewport: null, nodes: [{ id: 'a', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } }, { id: 'b', type: 'result', position: { x: 1, y: 0 }, data: { kind: 'image' } }, { id: 'c', type: 'result', position: { x: 2, y: 0 }, data: { kind: 'image' } }], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image-source', target: 'c', targetHandle: 'image-target' }, { id: 'e2', source: 'b', sourceHandle: 'image-source', target: 'c', targetHandle: 'image-target' }] } }], 'MAX_INCOMING_EXCEEDED'],
    ['有向环路', [{ type: 'replace_graph', graph: { version: 1, viewport: null, nodes: [{ id: 'a', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } }, { id: 'b', type: 'result', position: { x: 1, y: 0 }, data: { kind: 'image' } }], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image-source', target: 'b', targetHandle: 'image-target' }, { id: 'e2', source: 'b', sourceHandle: 'image-source', target: 'a', targetHandle: 'image-target' }] } }], 'CYCLE_NOT_ALLOWED'],
  ])('0B 拒绝%s且 batch 不留部分状态', async (_label, operations: any, code) => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'validator' });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 0, `bad-${code}`), operations })).rejects.toMatchObject({ response: { code } });
    expect((await service.findOne(canvas.id)).graph).toEqual(emptyCanvasGraph());
  });

  it('Checkpoint 可恢复，存在后续修改时 undo 被前置条件拒绝', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'human', holderId: 'reviewer' });
    const checkpoint = await service.createCheckpoint(canvas.id, { ...proof(lease, 0, 'cp'), name: '空白基线' });
    const change = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'rename-1'), operations: [{ type: 'rename_canvas', name: '第一版' }] });
    const log = (await service.operationLog(canvas.id))[0];
    await service.applyOperations(canvas.id, { ...proof(lease, change.resultRevision, 'brief-2'), operations: [{ type: 'set_brief', brief: { goal: '后续人工修改' } }] });
    await expect(service.undoOperation(canvas.id, log.id, { ...proof(lease, 2, 'unsafe-undo') })).rejects.toMatchObject({ status: 409 });
    const restored = await service.restoreCheckpoint(canvas.id, checkpoint.id, { ...proof(lease, 2, 'restore-cp') });
    expect(restored.canvas).toMatchObject({ name: '0A 验收', graph: emptyCanvasGraph(), brief: null, revision: 3 });
  });

  it('按工作流 inputConfig 精确拒绝不存在的动态 handle', async () => {
    const workflow = await db.getRepository(Workflow).save(db.getRepository(Workflow).create({ name: '端口测试', category: 'img2img', apiJson: '{}', exposureConfig: null, fieldConfig: null, thumbnailPath: null, description: null, tags: null, inputConfig: { version: 1, fields: [{ nodeId: '42', param: 'image', kind: 'image' }] } }));
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'ports' });
    const base: any[] = [{ type: 'create_node', node: { id: 'source', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } } }, { type: 'create_node', node: { id: 'target', type: 'txt2img', position: { x: 10, y: 0 }, data: { workflowId: workflow.id, formValues: {} } } }];
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 0, 'invalid-port'), operations: [...base, { type: 'connect', edge: { id: 'e', source: 'source', sourceHandle: 'image-source', target: 'target', targetHandle: 'input:target:not-declared' } }] })).rejects.toMatchObject({ response: { code: 'HANDLE_NOT_FOUND' } });
    const valid = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'valid-port'), operations: [...base, { type: 'connect', edge: { id: 'e', source: 'source', sourceHandle: 'image-source', target: 'target', targetHandle: 'input:42:image' } }] });
    expect(valid.canvas.graph.edges).toHaveLength(1);
  });

  it('动态 handle 支持包含冒号的 ComfyUI 子图节点 ID', async () => {
    const workflow = await db.getRepository(Workflow).save(db.getRepository(Workflow).create({ name: '子图端口', category: 'img2vid', apiJson: '{}', exposureConfig: null, fieldConfig: null, thumbnailPath: null, description: null, tags: null, inputConfig: { version: 1, fields: [{ nodeId: '105:104', param: 'prompt', kind: 'text' }] } }));
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'subgraph-port' });
    const connected = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'subgraph-text-port'), operations: [{ type: 'create_node', node: { id: 'source', type: 'codex-capability', position: { x: 0, y: 0 }, data: { capability: 'analyze', prompt: '分析', model: 'codex' } } }, { type: 'create_node', node: { id: 'target', type: 'txt2img', position: { x: 1, y: 0 }, data: { workflowId: workflow.id, formValues: {} } } }, { type: 'connect', edge: { id: 'e', source: 'source', sourceHandle: 'text-source', target: 'target', targetHandle: 'input:text:105:104:prompt' } }] });
    expect(connected.canvas.graph.edges[0].targetHandle).toBe('input:text:105:104:prompt');
  });

  it('Codex 文本输出可连接任意 Codex 提示词输入，图片输入仅限 edit/analyze', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'codex-links' });
    const text = { id: 'text', type: 'codex-capability' as const, position: { x: 0, y: 0 }, data: { capability: 'text', prompt: '写提示词', model: 'codex' } };
    const image = { id: 'image', type: 'codex-capability' as const, position: { x: 300, y: 0 }, data: { capability: 'image', prompt: '', model: 'codex' } };
    const connected = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'codex-text-link'), operations: [{ type: 'create_node', node: text }, { type: 'create_node', node: image }, { type: 'connect', edge: { id: 'text-edge', source: 'text', sourceHandle: 'text-source', target: 'image', targetHandle: 'text-target' } }] });
    expect(connected.canvas.graph.edges).toEqual([expect.objectContaining({ sourceHandle: 'text-source', targetHandle: 'text-target' })]);
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'invalid-codex-image-input'), operations: [{ type: 'connect', edge: { id: 'image-edge', source: 'image', sourceHandle: 'image-source', target: 'text', targetHandle: 'image-target' } }] })).rejects.toMatchObject({ response: { code: 'HANDLE_NOT_FOUND' } });
  });

  it('节点删除先提交 graph；资产文件垃圾回收失败不会回滚或损坏引用', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'gc-test' });
    await service.applyOperations(canvas.id, { ...proof(lease, 0, 'create-generated'), operations: [{ type: 'create_node', node: { id: 'gen', type: 'txt2img', position: { x: 0, y: 0 }, data: { workflowId: 'deleted-workflow', formValues: {}, lastAssets: [{ assetId: 'asset-1', url: '/api/assets/asset-1', kind: 'image' }] } } }] });
    assets.deleteGeneratedByNode.mockRejectedValueOnce(new Error('injected filesystem failure'));
    const deleted = await service.applyOperations(canvas.id, { ...proof(lease, 1, 'delete-generated'), operations: [{ type: 'delete_node', nodeId: 'gen' }] });
    expect(deleted.canvas.graph.nodes).toEqual([]);
    expect(deleted.resultRevision).toBe(2);
    expect((await service.operationLog(canvas.id))[0].operations).toEqual([{ type: 'delete_node', nodeId: 'gen' }]);
    expect(await db.getRepository(CanvasAssetGcJob).countBy({ canvasId: canvas.id, nodeId: 'gen' })).toBe(1);
    assets.deleteGeneratedByNode.mockResolvedValueOnce(undefined);
    await service.onModuleInit();
    expect(await db.getRepository(CanvasAssetGcJob).countBy({ canvasId: canvas.id, nodeId: 'gen' })).toBe(0);
  });

  it('Checkpoint 引用的节点资产受保护，覆盖恢复不会得到断裂引用', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'human', holderId: 'checkpoint-assets' });
    await service.applyOperations(canvas.id, { ...proof(lease, 0, 'asset-node'), operations: [{ type: 'create_node', node: { id: 'gen', type: 'txt2img', position: { x: 0, y: 0 }, data: { workflowId: 'old-workflow', formValues: {}, lastAssets: [{ assetId: 'asset-1', url: '/api/assets/asset-1', kind: 'image' }] } } }] });
    const checkpoint = await service.createCheckpoint(canvas.id, { ...proof(lease, 1, 'asset-cp'), name: '保留产出' });
    await service.applyOperations(canvas.id, { ...proof(lease, 1, 'asset-delete'), operations: [{ type: 'delete_node', nodeId: 'gen' }] });
    expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
    const restored = await service.restoreCheckpoint(canvas.id, checkpoint.id, { ...proof(lease, 2, 'asset-restore') });
    expect((restored.canvas.graph.nodes[0].data.lastAssets as any[])[0].assetId).toBe('asset-1');
  });

  it('Codex 多图端口接受 16 条入线并拒绝第 17 条', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'codex-multi-image' });
    const sources = Array.from({ length: 17 }, (_, index) => ({ id: `source-${index}`, type: 'result' as const, position: { x: 0, y: index * 10 }, data: { kind: 'image' } }));
    const target = { id: 'edit', type: 'codex-capability' as const, position: { x: 300, y: 0 }, data: { capability: 'edit', prompt: '组合参考图', model: 'codex' } };
    const first = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'multi-16'), operations: [
      ...sources.map((node) => ({ type: 'create_node' as const, node })), { type: 'create_node' as const, node: target },
      ...sources.slice(0, 16).map((node, index) => ({ type: 'connect' as const, edge: { id: `edge-${index}`, source: node.id, sourceHandle: 'image-source', target: 'edit', targetHandle: 'image-target' } })),
    ] });
    expect(first.canvas.graph.edges).toHaveLength(16);
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'multi-17'), operations: [{ type: 'connect', edge: { id: 'edge-16', source: 'source-16', sourceHandle: 'image-source', target: 'edit', targetHandle: 'image-target' } }] })).rejects.toMatchObject({ response: { code: 'MAX_INCOMING_EXCEEDED' } });
  });

  it('阻止断开仍被 @ 引用的图片，解除引用后允许断开', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'reference-protection' });
    const prompt = '使用 @角色图·edge01 的人物';
    await service.applyOperations(canvas.id, { ...proof(lease, 0, 'reference-setup'), operations: [
      { type: 'create_node', node: { id: 'source', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } } },
      { type: 'create_node', node: { id: 'edit', type: 'codex-capability', position: { x: 300, y: 0 }, data: { capability: 'edit', prompt, model: 'codex', promptImageReferences: [{ referenceId: 'edge-01', edgeId: 'edge-01', sourceNodeId: 'source', token: '@角色图·edge01', displayName: '角色图' }] } } },
      { type: 'connect', edge: { id: 'edge-01', source: 'source', sourceHandle: 'image-source', target: 'edit', targetHandle: 'image-target' } },
    ] });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'reference-blocked'), operations: [{ type: 'disconnect', edgeId: 'edge-01' }] })).rejects.toMatchObject({ response: { code: 'IMAGE_REFERENCE_IN_USE' } });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'reference-source-blocked'), operations: [{ type: 'delete_node', nodeId: 'source' }] })).rejects.toMatchObject({ response: { code: 'IMAGE_REFERENCE_IN_USE' } });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'reference-binding-bypass'), operations: [
      { type: 'update_node', nodeId: 'edit', dataPatch: { promptImageReferences: [] } },
      { type: 'disconnect', edgeId: 'edge-01' },
    ] })).rejects.toMatchObject({ response: { code: 'IMAGE_REFERENCE_IN_USE' } });
    const released = await service.applyOperations(canvas.id, { ...proof(lease, 1, 'reference-released'), operations: [
      { type: 'update_node', nodeId: 'edit', dataPatch: { prompt: '不再引用图片' } },
      { type: 'disconnect', edgeId: 'edge-01' },
    ] });
    expect(released.canvas.graph.edges).toEqual([]);
  });

  it('MiniMax H3 统一参考图端口接受 9 张并保护 formValues 中的稳定 @ 引用', async () => {
    const workflows = db.getRepository(Workflow);
    const workflow = await workflows.save(workflows.create({ name: 'MiniMax H3 全能参考', category: 'reference', apiJson: JSON.stringify({ '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } }), exposureConfig: null, fieldConfig: null, thumbnailPath: null, description: null, tags: null, inputConfig: { version: 1, fields: [] } }));
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'h3-reference' });
    const sources = Array.from({ length: 10 }, (_, index) => ({ id: `h3-source-${index}`, type: 'result' as const, position: { x: 0, y: index * 10 }, data: { kind: 'image' } }));
    const token = '@角色·stable1';
    const first = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'h3-nine'), operations: [
      ...sources.map((node) => ({ type: 'create_node' as const, node })),
      { type: 'create_node', node: { id: 'h3', type: 'txt2img', position: { x: 300, y: 0 }, data: { workflowId: workflow.id, formValues: { '138::value': `使用 ${token}` }, promptImageReferences: [{ referenceId: 'h3-edge-0', edgeId: 'h3-edge-0', sourceNodeId: sources[0].id, token, displayName: '角色' }] } } },
      ...sources.slice(0, 9).map((node, index) => ({ type: 'connect' as const, edge: { id: `h3-edge-${index}`, source: node.id, sourceHandle: 'image-source', target: 'h3', targetHandle: 'input:image:reference-group:images' } })),
    ] });
    expect(first.canvas.graph.edges).toHaveLength(9);
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'h3-ten'), operations: [{ type: 'connect', edge: { id: 'h3-edge-9', source: sources[9].id, sourceHandle: 'image-source', target: 'h3', targetHandle: 'input:image:reference-group:images' } }] })).rejects.toMatchObject({ response: { code: 'MAX_INCOMING_EXCEEDED' } });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'h3-ref-block'), operations: [{ type: 'disconnect', edgeId: 'h3-edge-0' }] })).rejects.toMatchObject({ response: { code: 'IMAGE_REFERENCE_IN_USE' } });
    const released = await service.applyOperations(canvas.id, { ...proof(lease, 1, 'h3-ref-release'), operations: [{ type: 'update_node', nodeId: 'h3', dataPatch: { formValues: { '138::value': '不再引用', }, promptImageReferences: [] } }, { type: 'disconnect', edgeId: 'h3-edge-0' }] });
    expect(released.canvas.graph.edges).toHaveLength(8);
  });

  it('Z-Image 统一参考图端口保持真实的一张上限', async () => {
    const workflows = db.getRepository(Workflow);
    const workflow = await workflows.save(workflows.create({ name: 'Z-Image Turbo 通用高质量图生图', category: 'img2img', apiJson: '{}', exposureConfig: null, fieldConfig: null, thumbnailPath: null, description: null, tags: null, inputConfig: { version: 1, fields: [{ nodeId: '7', param: 'image', kind: 'image' }] } }));
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'z-image-reference' });
    await service.applyOperations(canvas.id, { ...proof(lease, 0, 'z-one'), operations: [
      { type: 'create_node', node: { id: 'a', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } } },
      { type: 'create_node', node: { id: 'b', type: 'result', position: { x: 0, y: 100 }, data: { kind: 'image' } } },
      { type: 'create_node', node: { id: 'z', type: 'txt2img', position: { x: 300, y: 0 }, data: { workflowId: workflow.id, formValues: {} } } },
      { type: 'connect', edge: { id: 'z-edge-a', source: 'a', sourceHandle: 'image-source', target: 'z', targetHandle: 'input:image:reference-group:images' } },
    ] });
    await expect(service.applyOperations(canvas.id, { ...proof(lease, 1, 'z-two'), operations: [{ type: 'connect', edge: { id: 'z-edge-b', source: 'b', sourceHandle: 'image-source', target: 'z', targetHandle: 'input:image:reference-group:images' } }] })).rejects.toMatchObject({ response: { code: 'MAX_INCOMING_EXCEEDED' } });
  });

  it('AI 配音节点接受文本与双音频输入并输出音频', async () => {
    const canvas = await create(); const lease = await service.acquire(canvas.id, { holderType: 'human', holderId: 'tts-graph' });
    const result = await service.applyOperations(canvas.id, { ...proof(lease, 0, 'tts-graph'), operations: [
      { type: 'create_node', node: { id: 'voice', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'audio', inputMode: true } } },
      { type: 'create_node', node: { id: 'emotion', type: 'result', position: { x: 0, y: 100 }, data: { kind: 'audio', inputMode: true } } },
      { type: 'create_node', node: { id: 'text', type: 'result', position: { x: 0, y: 200 }, data: { kind: 'text', inputMode: true } } },
      { type: 'create_node', node: { id: 'tts', type: 'tts', position: { x: 300, y: 0 }, data: { provider: 'indextts2', text: '', referenceText: '', instruction: '', speed: 1 } } },
      { type: 'create_node', node: { id: 'audio', type: 'result', position: { x: 600, y: 0 }, data: { kind: 'audio' } } },
      { type: 'connect', edge: { id: 'voice-edge', source: 'voice', sourceHandle: 'audio-source', target: 'tts', targetHandle: 'audio-target' } },
      { type: 'connect', edge: { id: 'emotion-edge', source: 'emotion', sourceHandle: 'audio-source', target: 'tts', targetHandle: 'emotion-audio-target' } },
      { type: 'connect', edge: { id: 'text-edge', source: 'text', sourceHandle: 'text-source', target: 'tts', targetHandle: 'text-target' } },
      { type: 'connect', edge: { id: 'output-edge', source: 'tts', sourceHandle: 'audio-source', target: 'audio', targetHandle: 'audio-target' } },
    ] });
    expect(result.canvas.graph.nodes).toHaveLength(5);
    expect(result.canvas.graph.edges).toHaveLength(4);
  });

});
