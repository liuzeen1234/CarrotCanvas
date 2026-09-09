import { SpeechEvaluatorService } from './speech-evaluator.service';

describe('SpeechEvaluatorService', () => {
  it('holds one outer lease while processing tool-major and item-serial', async () => {
    const events: string[] = [];
    const rows = [0, 1].map((position) => ({ id: `item-${position}`, evaluationRunId: 'run', position, targetAssetId: `asset-${position}`,
      referenceAssetId: null, targetText: null, sourceRunId: null, status: 'queued', stages: {
        'audio-profile': { status: 'pending' }, 'pause-timing': { status: 'pending' }, 'pitch-energy': { status: 'pending' },
      }, finalResult: null, error: null, startedAt: null, finishedAt: null }));
    let reads = 0;
    const repository = { find: jest.fn(async () => rows), save: jest.fn(async (value) => value) } as any;
    const scheduler = { registerProvider: jest.fn(), acquire: jest.fn(async () => { events.push('lease-acquired'); return { release: async () => events.push('lease-released') }; }) } as any;
    const assets = { read: jest.fn(async ({ } = {}) => { const item = rows[reads++ % 2]; const stage = ['audio-profile', 'pause-timing', 'pitch-energy'][Math.floor((reads - 1) / 2)]; events.push(`${stage}:${item.position}`); return { absPath: 'unused' }; }) } as any;
    const runs = { patch: jest.fn(async () => undefined), finish: jest.fn(async () => { events.push('final-persisted'); }) } as any;
    const service = new SpeechEvaluatorService(repository, scheduler, assets, runs);
    jest.spyOn(require('./wav-analysis'), 'decodeWav').mockResolvedValue({ sampleRate: 16000, channels: 1, samples: new Float64Array(1600), durationMs: 100 });
    await (service as any).execute('run');
    expect(events).toEqual(['lease-acquired', 'audio-profile:0', 'audio-profile:1', 'pause-timing:0', 'pause-timing:1', 'pitch-energy:0', 'pitch-energy:1', 'final-persisted', 'lease-released']);
  });
});
