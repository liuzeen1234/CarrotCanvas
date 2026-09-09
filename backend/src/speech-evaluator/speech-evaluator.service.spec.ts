import { SpeechEvaluatorService } from './speech-evaluator.service';

describe('SpeechEvaluatorService', () => {
  it('holds one outer lease while processing tool-major and item-serial', async () => {
    const events: string[] = [];
    const rows = [0, 1].map((position) => ({ id: `item-${position}`, evaluationRunId: 'run', position, targetAssetId: `asset-${position}`,
      referenceAssetId: null, targetText: null, sourceRunId: null, status: 'queued', stages: {
        funasr: { status: 'pending' }, 'audio-profile': { status: 'pending' }, 'pause-timing': { status: 'pending' }, 'pitch-energy': { status: 'pending' }, wespeaker: { status: 'pending' }, utmosv2: { status: 'pending' },
      }, finalResult: null, error: null, startedAt: null, finishedAt: null }));
    let reads = 0;
    const repository = { find: jest.fn(async () => rows), save: jest.fn(async (value) => value) } as any;
    const scheduler = { registerProvider: jest.fn(), acquire: jest.fn(async () => { events.push('lease-acquired'); return { release: async () => events.push('lease-released') }; }) } as any;
    const assets = { read: jest.fn(async () => { const call = reads++; if (call >= 2 && call < 8) { const item = rows[(call - 2) % 2]; const stage = ['audio-profile', 'pause-timing', 'pitch-energy'][Math.floor((call - 2) / 2)]; events.push(`${stage}:${item.position}`); } return { absPath: 'unused' }; }) } as any;
    const runs = { patch: jest.fn(async () => undefined), finish: jest.fn(async () => { events.push('final-persisted'); }) } as any;
    const toolRunner = { clearCancellation: jest.fn(), cancellationFile: jest.fn(), run: jest.fn(async (stage: string, inputs: unknown[], runId: string, onEvent: (event: any) => Promise<void>) => {
      events.push(`${stage}:batch`); const output = rows.map(() => stage === 'wespeaker' ? { status: 'unavailable' } : stage === 'utmosv2' ? { predictedMos: 4 } : { transcript: '测试', cer: 0 });
      for (const [index, result] of output.entries()) { await onEvent({ index, status: 'started' }); await onEvent({ index, status: 'completed', result }); }
      return { items: output, cancelled: false };
    }) } as any;
    const service = new SpeechEvaluatorService(repository, scheduler, assets, runs, toolRunner);
    jest.spyOn(require('./wav-analysis'), 'decodeWav').mockResolvedValue({ sampleRate: 16000, channels: 1, samples: new Float64Array(1600), durationMs: 100 });
    await (service as any).execute('run');
    expect(events).toEqual(['lease-acquired', 'funasr:batch', 'audio-profile:0', 'audio-profile:1', 'pause-timing:0', 'pause-timing:1', 'pitch-energy:0', 'pitch-energy:1', 'wespeaker:batch', 'utmosv2:batch', 'final-persisted', 'lease-released']);
  });

  it('persists each model item event before the next audio starts and cancels at the safe boundary', async () => {
    const events: string[] = [];
    const rows = [0, 1].map((position) => ({ id: `item-${position}`, evaluationRunId: 'run', position, targetAssetId: `asset-${position}`,
      referenceAssetId: null, targetText: '测试', sourceRunId: null, status: 'queued', stages: Object.fromEntries(['funasr', 'audio-profile', 'pause-timing', 'pitch-energy', 'wespeaker', 'utmosv2'].map((stage) => [stage, { status: 'pending' }])), finalResult: null, error: null, startedAt: null, finishedAt: null }));
    const repository = { find: jest.fn(async () => rows), save: jest.fn(async (item: any) => { const activeStage = Object.entries(item.stages).find(([, state]: any) => state.status === 'running'); if (activeStage) events.push(`save:${item.position}:${activeStage[0]}:running`); return item; }) } as any;
    const scheduler = { registerProvider: jest.fn(), acquire: jest.fn(async () => ({ release: async () => events.push('lease-released') })) } as any;
    const assets = { read: jest.fn(async () => ({ absPath: 'unused' })) } as any;
    const runs = { get: jest.fn(async () => ({ id: 'run', provider: 'speech-evaluator', status: 'running' })), patch: jest.fn(), finish: jest.fn(async (_id: string, status: string) => events.push(`run:${status}`)) } as any;
    const toolRunner = { clearCancellation: jest.fn(), cancel: jest.fn(), release: jest.fn(), run: jest.fn(async (_stage: string, _inputs: unknown[], _runId: string, onEvent: (event: any) => Promise<void>) => {
      await onEvent({ index: 0, status: 'started' });
      await onEvent({ index: 0, status: 'completed', result: { transcript: '测试', cer: 0 } });
      events.push('worker:next-boundary');
      return { items: [{ transcript: '测试', cer: 0 }], cancelled: true };
    }) } as any;
    const service = new SpeechEvaluatorService(repository, scheduler, assets, runs, toolRunner);
    await (service as any).execute('run');
    expect(events.indexOf('save:0:funasr:running')).toBeLessThan(events.indexOf('worker:next-boundary'));
    expect(events).toContain('run:cancelled');
    expect(events.at(-1)).toBe('lease-released');
    expect(rows[0].stages.funasr.status).toBe('succeeded');
    expect(rows[1].stages.funasr.status).toBe('pending');
  });

  it('recovers a restarted evaluation only from version-compatible safe boundaries', async () => {
    const row: any = { evaluationRunId: 'run', status: 'running', stages: {
      funasr: { status: 'succeeded', toolVersion: 'funasr-1.4.1/paraformer-zh' },
      'audio-profile': { status: 'running', toolVersion: 'builtin-1' },
      'pause-timing': { status: 'pending' }, 'pitch-energy': { status: 'pending' }, wespeaker: { status: 'pending' }, utmosv2: { status: 'pending' },
    } };
    const repository = { find: jest.fn(async () => [row]), save: jest.fn(async (value) => value) } as any;
    const scheduler = { registerProvider: jest.fn() } as any; const assets = {} as any;
    const runs = { registerCancelHandler: jest.fn(), list: jest.fn(async () => ({ items: [{ id: 'run' }] })), patch: jest.fn(async () => undefined) } as any;
    const toolRunner = { release: jest.fn() } as any;
    const service = new SpeechEvaluatorService(repository, scheduler, assets, runs, toolRunner);
    jest.spyOn(service, 'start').mockImplementation(() => undefined);
    await service.onApplicationBootstrap();
    expect(row.stages.funasr.status).toBe('succeeded');
    expect(row.stages['audio-profile']).toEqual({ status: 'pending' });
    expect(runs.patch).toHaveBeenCalledWith('run', { status: 'queued', error: null, finishedAt: null });
    expect(service.start).toHaveBeenCalledWith('run');
  });

  it('fails only the evaluation run and leaves the source TTS run and asset untouched', async () => {
    const row: any = { id: 'item-0', evaluationRunId: 'eval-run', position: 0, sourceRunId: 'tts-run', targetAssetId: 'tts-audio', referenceAssetId: null,
      targetText: '测试', status: 'queued', stages: Object.fromEntries(['funasr', 'audio-profile', 'pause-timing', 'pitch-energy', 'wespeaker', 'utmosv2'].map((stage) => [stage, { status: 'pending' }])), finalResult: null, error: null, startedAt: null, finishedAt: null };
    const repository = { find: jest.fn(async () => [row]), save: jest.fn(async (value) => value) } as any;
    const scheduler = { registerProvider: jest.fn(), acquire: jest.fn(async () => ({ release: jest.fn() })) } as any;
    const assets = { read: jest.fn(async () => ({ asset: { id: 'tts-audio', kind: 'audio' }, absPath: 'tts.wav' })) } as any;
    const runs = { patch: jest.fn(), finish: jest.fn(), get: jest.fn(async (id: string) => ({ id, provider: id === 'tts-run' ? 'indextts2' : 'speech-evaluator', status: id === 'tts-run' ? 'succeeded' : 'running', outputAssetIds: id === 'tts-run' ? ['tts-audio'] : [] })) } as any;
    const toolRunner = { clearCancellation: jest.fn(), run: jest.fn(async () => { throw new Error('evaluation model failed'); }) } as any;
    const service = new SpeechEvaluatorService(repository, scheduler, assets, runs, toolRunner);
    const sourceBefore = await runs.get('tts-run');
    await (service as any).execute('eval-run');
    const sourceAfter = await runs.get('tts-run');
    expect(runs.finish).toHaveBeenCalledWith('eval-run', 'failed', [], expect.objectContaining({ message: 'evaluation model failed' }));
    expect(runs.finish).not.toHaveBeenCalledWith('tts-run', expect.anything(), expect.anything(), expect.anything());
    expect(sourceAfter).toEqual(sourceBefore);
    expect(assets.read).toHaveBeenCalledWith('tts-audio');
  });
});
