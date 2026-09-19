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

  it('persists queued, started and finished timestamps for duration display', async () => {
    const begun = await service.begin({ provider: 'codex2api', canvasId: 'c1', nodeId: 'n1', inputSnapshot: {} });
    const startedAt = begun.run.queuedAt;
    await service.patch(begun.run.id, { status: 'running', startedAt });
    const finished = await service.finish(begun.run.id, 'succeeded', [], null, 'done');
    expect(finished.queuedAt).toBe(begun.run.queuedAt);
    expect(finished.startedAt).toBe(startedAt);
    expect(finished.finishedAt).toEqual(expect.any(Number));
    expect(finished.finishedAt!).toBeGreaterThanOrEqual(startedAt);
    const listed = await service.list({ canvasId: 'c1' });
    expect(listed.items[0]).toMatchObject({ id: begun.run.id, queuedAt: begun.run.queuedAt, startedAt, finishedAt: finished.finishedAt });
  });

  it('lists actual audio asset metadata without inferring media kind from workflow name', async () => {
    await (service as any).assets.save({ id: 'flac-id', canvasId: 'c1', nodeId: 'n1', kind: 'audio', source: 'generated', relPath: 'c1/test.flac', originName: 'test.flac', mime: 'audio/flac' });
    const begun = await service.begin({ provider: 'comfyui', canvasId: 'c1', nodeId: 'n1', inputSnapshot: {} });
    await service.finish(begun.run.id, 'succeeded', ['flac-id']);
    expect((await service.list({ canvasId: 'c1' })).items[0].outputAssets).toEqual([{ assetId: 'flac-id', kind: 'audio', filename: 'test.flac', mime: 'audio/flac' }]);
  });

  it('selects the latest asset per kind when one run outputs both video and audio', async () => {
    // H3 图生视频卡：一次运行同时产出音频与视频，音频排在输出数组第一位。
    await (service as any).assets.save({ id: 'vid-1', canvasId: 'c1', nodeId: 'h3', kind: 'video', source: 'generated', relPath: 'c1/v1.mp4', mime: 'video/mp4' });
    await (service as any).assets.save({ id: 'aud-1', canvasId: 'c1', nodeId: 'h3', kind: 'audio', source: 'generated', relPath: 'c1/a1.flac', mime: 'audio/flac' });
    const run = await service.begin({ provider: 'comfyui', canvasId: 'c1', nodeId: 'h3', inputSnapshot: {} });
    await service.finish(run.run.id, 'succeeded', ['aud-1', 'vid-1']);
    const group = await service.group('c1', 'h3');
    // 视频与音频各自默认选中本次的最新产物，互不覆盖。
    expect(group?.selectedByKind).toEqual({ audio: 'aud-1', video: 'vid-1' });
    // selectedAssetId 主 kind 取视频（video > image > audio），而非输出数组首位的音频。
    expect(group?.selectedAssetId).toBe('vid-1');
    // 手动改选音频只影响音频轨道，视频选中保持不变。
    const chosen = await service.choose('c1', 'h3', null, 'aud-1', false, 'human');
    expect(chosen.selectedByKind).toEqual({ audio: 'aud-1', video: 'vid-1' });
  });

  it('marks unfinished runs needs_attention during restart reconciliation', async () => {
    const begun = await service.begin({ provider: 'comfyui', inputSnapshot: {} });
    await service.patch(begun.run.id, { status: 'running' });
    await service.onModuleInit();
    expect(await service.get(begun.run.id)).toMatchObject({ status: 'needs_attention', finishedAt: expect.any(Number) });
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
