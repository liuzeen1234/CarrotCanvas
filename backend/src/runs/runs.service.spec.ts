import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from './generation-run.entity';
import { RunsService } from './runs.service';

describe('RunsService persistence', () => {
  let service: RunsService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', dropSchema: true, entities: [GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Asset], synchronize: true }),
        TypeOrmModule.forFeature([GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Asset]),
      ],
      providers: [RunsService],
    }).compile();
    service = module.get(RunsService);
  });

  it('deduplicates provider submission records by idempotency key', async () => {
    const first = await service.begin({ provider: 'comfyui', inputSnapshot: { prompt: 'a', nested: { x: 1, y: 2 } }, idempotencyKey: 'same' });
    const second = await service.begin({ provider: 'comfyui', inputSnapshot: { nested: { y: 2, x: 1 }, prompt: 'a' }, idempotencyKey: 'same' });
    expect(second.replay).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it('appends candidates across reruns and protects approval from replacement', async () => {
    const first = await service.begin({ provider: 'codex2api', canvasId: 'c1', nodeId: 'n1', inputSnapshot: {} });
    await service.finish(first.run.id, 'succeeded', ['a1']);
    const second = await service.begin({ provider: 'codex2api', canvasId: 'c1', nodeId: 'n1', inputSnapshot: {} });
    await service.finish(second.run.id, 'succeeded', ['a2']);
    expect((await service.group('c1', 'n1'))?.candidateAssetIds).toEqual(['a1', 'a2']);
    expect((await service.group('c1', 'n1'))?.selectedAssetId).toBe('a2');
    await service.choose('c1', 'n1', null, 'a1', true, 'human');
    await expect(service.choose('c1', 'n1', null, 'a2', true, 'human')).rejects.toMatchObject({ status: 409 });
  });

  it('persists text output and automatically selects the newest successful version', async () => {
    const first = await service.begin({ provider: 'codex2api', canvasId: 'c1', nodeId: 'text-node', inputSnapshot: {} });
    await service.finish(first.run.id, 'succeeded', [], null, 'first answer');
    const second = await service.begin({ provider: 'codex2api', canvasId: 'c1', nodeId: 'text-node', inputSnapshot: {} });
    await service.finish(second.run.id, 'succeeded', [], null, 'second answer', { positive: 'bright rabbit', negative: 'blur' });
    expect((await service.get(second.run.id)).outputText).toBe('second answer');
    expect((await service.get(second.run.id)).outputParts).toEqual({ positive: 'bright rabbit', negative: 'blur' });
    expect((await service.group('c1', 'text-node'))?.selectedRunId).toBe(second.run.id);
    await service.chooseText('c1', 'text-node', first.run.id);
    expect((await service.group('c1', 'text-node'))?.selectedRunId).toBe(first.run.id);
  });

  it('marks unfinished runs needs_attention during restart reconciliation', async () => {
    const begun = await service.begin({ provider: 'comfyui', inputSnapshot: {} });
    await service.patch(begun.run.id, { status: 'running' });
    await service.onModuleInit();
    expect((await service.get(begun.run.id)).status).toBe('needs_attention');
  });

  it('hands the same platform/provider run to a new lease without resubmission', async () => {
    const begun = await service.begin({ provider: 'comfyui', canvasId: 'c1', inputSnapshot: {}, providerRunId: 'provider-1', actorType: 'agent', actorId: 'agent-a' });
    const record = await service.recordRelease(begun.run.id, { actorType: 'agent', actorId: 'agent-a', leaseEpoch: 3, summary: '仍在运行' });
    const adopted = await service.adopt(begun.run.id, { actorType: 'human', actorId: 'human-b', leaseEpoch: 4 });
    expect(adopted.run.id).toBe(begun.run.id);
    expect(adopted.run.providerRunId).toBe('provider-1');
    expect(adopted.handoff.id).toBe(record.id);
    expect((await service.adopt(begun.run.id, { actorType: 'human', actorId: 'human-b', leaseEpoch: 4 })).replay).toBe(true);
    await expect(service.adopt(begun.run.id, { actorType: 'agent', actorId: 'agent-c', leaseEpoch: 5 })).rejects.toMatchObject({ status: 409 });
  });

  it('exposes honest provider cancellation limits and lease-independent status updates', async () => {
    const comfy = (await service.begin({ provider: 'comfyui', inputSnapshot: {} })).run;
    const codex = (await service.begin({ provider: 'codex2api', inputSnapshot: {} })).run;
    expect(service.capabilities(comfy)).toMatchObject({ cancel: { precise: false, mode: 'global-if-sole-active' }, statusUpdatesRequireLease: false });
    expect(service.capabilities(codex)).toMatchObject({ cancel: { precise: false, mode: 'unsupported' } });
  });
});
