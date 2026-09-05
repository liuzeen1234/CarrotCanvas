import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun } from './generation-run.entity';
import { RunsService } from './runs.service';

describe('RunsService persistence', () => {
  let service: RunsService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', dropSchema: true, entities: [GenerationRun, GenerationCandidateGroup, Asset], synchronize: true }),
        TypeOrmModule.forFeature([GenerationRun, GenerationCandidateGroup, Asset]),
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
});
