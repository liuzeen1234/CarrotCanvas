import { DataSource } from 'typeorm';
import { ComfyUIController } from './comfyui.controller';
import { ComfyUIRunnerService } from './comfyui-runner.service';
import { ComfyUISchemaService } from './comfyui-schema.service';
import { ComfyUIProcessManagerService } from './comfyui-process-manager.service';
import { ComfyUIGpuProviderService } from './comfyui-gpu-provider.service';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { LocalComputeLease } from '../gpu-scheduler/gpu-resource-lease.entity';
import { RunsService } from '../runs/runs.service';
import { GenerationRun, GenerationRunHandoff, GenerationCandidateGroup } from '../runs/generation-run.entity';
import { Asset } from '../assets/asset.entity';
import { promises as fs } from 'fs';

describe('ComfyUI run cold start (real persistence, scheduler and runner)', () => {
  let db: DataSource;
  let runs: RunsService;
  let scheduler: LocalComputeSchedulerService;
  let controller: ComfyUIController;
  let runner: ComfyUIRunnerService;
  let processes: ComfyUIProcessManagerService;
  let online: boolean;
  let external: boolean;
  let events: string[];
  let client: any;
  let start: jest.SpyInstance;
  let kill: jest.SpyInstance;
  const launch = { executable: 'saved-python', args: ['main.py'], cwd: 'saved-cwd' };
  const graph = (steps = '4') => ({ '1': { class_type: 'Example', inputs: { steps, filename_prefix: '%date:yyyy%' } } });
  const body = (key = 'same', steps = '4') => ({ workflowId: 'workflow', apiJson: graph(steps), idempotencyKey: key });

  beforeEach(async () => {
    online = false; external = false; events = [];
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true,
      entities: [GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Asset, LocalComputeLease] }).initialize();
    runs = new RunsService(db.getRepository(GenerationRun), db.getRepository(GenerationRunHandoff), db.getRepository(GenerationCandidateGroup), db.getRepository(Asset));
    scheduler = new LocalComputeSchedulerService(db.getRepository(LocalComputeLease));
    client = {
      getObjectInfo: jest.fn(async () => {
        events.push('object-info');
        if (!online) throw new Error('offline');
        expect(scheduler.getState().active?.status).toBe('active');
        return { Example: { input: { required: { steps: ['INT', { min: 1, max: 10 }], filename_prefix: ['STRING', {}] } } } };
      }),
      submitPrompt: jest.fn(async (apiJson) => {
        events.push('prompt');
        expect(online).toBe(true);
        const saved = await db.getRepository(GenerationRun).findOneByOrFail({ id: scheduler.getState().active!.runId });
        expect(saved.inputSnapshot).toEqual(apiJson);
        return { prompt_id: `prompt-${client.submitPrompt.mock.calls.length}`, node_errors: {} };
      }),
      getQueue: jest.fn(async () => ({ queue_running: [], queue_pending: [] })),
    };
    processes = new ComfyUIProcessManagerService({ get: jest.fn(async (key) => key === 'comfyui-managed-launch' ? { value: JSON.stringify(launch) } : null), set: jest.fn() } as any, client);
    jest.spyOn(processes, 'inspect').mockImplementation(async () => ({ port: 8188,
      portOwner: online ? { pid: 1, name: 'python', path: 'saved-python', workingSetBytes: 1, privateBytes: 1 } : null,
      desktopProcesses: [], allocator: null, globalGpuMemoryUsedBytes: 0 }));
    jest.spyOn(processes as any, 'isManagedProcess').mockImplementation(async () => !external);
    start = jest.spyOn(processes as any, 'start').mockImplementation(async (...args) => {
      expect(args[0]).toEqual(launch);
      expect(await db.getRepository(GenerationRun).count()).toBeGreaterThan(0);
      events.push('start-healthy'); online = true;
      return processes.inspect();
    });
    kill = jest.spyOn(processes as any, 'killTree').mockResolvedValue('ok');
    jest.spyOn(processes, 'releaseManaged').mockImplementation(async () => { events.push('stop'); online = false; return { stopped: true, attempts: [] }; });
    new ComfyUIGpuProviderService(scheduler, client, processes).onModuleInit();
    runner = new ComfyUIRunnerService(client);
    jest.spyOn(runner as any, 'ensureWs').mockResolvedValue(undefined);
    controller = new ComfyUIController(client, runner,
      { findOne: jest.fn(async () => ({ id: 'workflow', name: 'test', updatedAt: new Date(0), apiJson: graph() })) } as any,
      new ComfyUISchemaService(), { captureRunOutputs: jest.fn() } as any,
      { assertWriteAccess: jest.fn() } as any, {} as any, runs, scheduler, processes);
  });
  afterEach(async () => { runner.onModuleDestroy(); await db.destroy(); });

  async function complete() { await (runner as any).finishSuccess(runner.listRuns()[0]); }
  async function expectFailure() {
    const [run] = await db.getRepository(GenerationRun).find();
    expect(run.status).toBe('failed');
    expect(scheduler.getState().active).toBeNull();
    expect(await db.getRepository(LocalComputeLease).find()).toEqual([expect.objectContaining({ status: 'failed', releasedAt: expect.any(Number) })]);
  }

  it('boots from saved configuration before metadata, freezes actual prompt and completes', async () => {
    const result = await controller.run(body());
    expect(events).toEqual(['start-healthy', 'object-info', 'prompt']);
    expect(result.run.runId).toBeDefined();
    expect(client.submitPrompt.mock.calls[0][0]['1'].inputs).toEqual({ steps: 4, filename_prefix: String(new Date().getFullYear()) });
    await complete();
    expect((await runs.get(result.run.runId)).status).toBe('succeeded');
    expect(scheduler.getState()).toMatchObject({ active: null, residentProvider: 'comfyui', blocked: null });
  });

  it('records startup failure without reading metadata or retaining a lease', async () => {
    start.mockRejectedValue(new Error('boot failed'));
    await expect(controller.run(body())).rejects.toThrow('boot failed');
    await expectFailure();
    expect(client.getObjectInfo).not.toHaveBeenCalled();
    expect(scheduler.getState().residentProvider).toBeNull();
  });

  it.each(['metadata', 'parameters', 'submit', 'snapshot'])('cleans up %s failure after acquire', async (stage) => {
    if (stage === 'metadata') client.getObjectInfo.mockRejectedValue(new Error('metadata failed'));
    if (stage === 'submit') client.submitPrompt.mockRejectedValue(new Error('submit failed'));
    if (stage === 'snapshot') {
      const original = runs.patch.bind(runs);
      jest.spyOn(runs, 'patch').mockImplementation(async (id, patch) => {
        if (patch.inputSnapshot) throw new Error('snapshot failed');
        return original(id, patch);
      });
    }
    await expect(controller.run(body('same', stage === 'parameters' ? 'invalid' : '4'))).rejects.toThrow();
    await expectFailure();
    // A healthy ComfyUI is intentionally retained, but no task owns compute.
    expect(scheduler.getState().residentProvider).toBe('comfyui');
    if (stage !== 'submit') expect(client.submitPrompt).not.toHaveBeenCalled();
  });

  it('preserves external-process confirmation and retries the same run exactly once', async () => {
    online = true; external = true;
    await expect(controller.run(body())).rejects.toMatchObject({ response: { code: 'COMFYUI_TAKEOVER_REQUIRED' } });
    await expectFailure();
    expect(kill).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(client.getObjectInfo).not.toHaveBeenCalled();
    external = false; scheduler.clearBlock();
    await Promise.all([controller.run(body()), controller.run(body())]);
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
    expect((await db.getRepository(GenerationRun).find())[0].attemptCount).toBe(2);
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    await complete();
  });

  it('deduplicates concurrent requests and replays offline after prepared snapshot changed', async () => {
    const results = await Promise.all([controller.run(body()), controller.run(body())]);
    expect(results[0].run.runId).toBe(results[1].run.runId);
    await complete(); online = false;
    const replay = await controller.run(body());
    expect(replay).toMatchObject({ replay: true });
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.getObjectInfo).toHaveBeenCalledTimes(1);
    expect(await db.getRepository(GenerationRun).count()).toBe(1);
    await expect(controller.run(body('same', '5'))).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('preserves online operation, FIFO, residency and cross-provider release', async () => {
    online = true;
    await controller.run(body('one'));
    const second = controller.run(body('two'));
    while (!scheduler.getState().waiting.length) await new Promise(resolve => setImmediate(resolve));
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);
    await complete(); await second;
    expect(client.submitPrompt).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    await complete();
    const next = await scheduler.acquire('cosyvoice3', 'tts');
    expect(events.at(-1)).toBe('stop');
    await next.release();
  });

  it('rejects invalid API JSON before creating a run or starting ComfyUI', async () => {
    await expect(controller.run({ ...body(), apiJson: {} })).rejects.toThrow();
    expect(await db.getRepository(GenerationRun).count()).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('releases even when writing the failed run throws', async () => {
    client.getObjectInfo.mockRejectedValue(new Error('offline'));
    jest.spyOn(runs, 'finish').mockRejectedValue(new Error('database unavailable'));
    await expect(controller.run(body())).rejects.toThrow('database unavailable');
    expect(scheduler.getState().active).toBeNull();
    expect((await db.getRepository(LocalComputeLease).find())[0].status).toBe('failed');
  });

  it('keeps accepted work exclusive when provider-id persistence fails, then releases at completion', async () => {
    const original = runs.patch.bind(runs);
    let failed = false;
    jest.spyOn(runs, 'patch').mockImplementation(async (id, patch) => {
      if (patch.providerRunId && !failed) { failed = true; throw new Error('metadata write failed'); }
      return original(id, patch);
    });
    await expect(controller.run(body())).rejects.toThrow('metadata write failed');
    expect(scheduler.getState().active).not.toBeNull();
    expect((await db.getRepository(GenerationRun).find())[0].status).toBe('needs_attention');
    await complete();
    expect(scheduler.getState().active).toBeNull();
    expect((await db.getRepository(GenerationRun).find())[0].status).toBe('succeeded');
  });

  it('schema lookup while offline never starts or acquires compute', async () => {
    await expect(controller.workflowSchema('workflow')).rejects.toThrow('offline');
    expect(start).not.toHaveBeenCalled();
    expect(await db.getRepository(LocalComputeLease).count()).toBe(0);
  });

  it('asset forwarding while offline never starts or acquires compute', async () => {
    (controller as any).assets = { read: async () => ({ asset: { id: 'asset', canvasId: 'canvas', kind: 'image', originName: 'input.png' }, absPath: 'unused' }) };
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('image'));
    client.uploadImage = jest.fn().mockRejectedValue(new Error('offline'));
    try { await expect(controller.uploadAsset({ canvasId: 'canvas', assetId: 'asset' })).rejects.toThrow('offline'); }
    finally { read.mockRestore(); }
    expect(start).not.toHaveBeenCalled();
    expect(await db.getRepository(LocalComputeLease).count()).toBe(0);
  });
});
