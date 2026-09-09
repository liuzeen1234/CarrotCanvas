import { BadRequestException } from '@nestjs/common';
import { join } from 'path';
import { TtsController } from './tts.controller';

describe('TtsController', () => {
  const control = { leaseToken: 'token', leaseEpoch: 1, expectedRevision: 0 };
  const reference = { asset: { id: 'voice', canvasId: 'canvas', kind: 'audio' }, absPath: join(__dirname, '..', '..', 'tts-worker', 'requirements-cosyvoice-windows.txt') };

  it('runs synthesis under a GPU lease and persists the audio candidate', async () => {
    const events: string[] = [];
    const client = { infer: jest.fn(async () => { events.push('infer'); return { buffer: pcmWav(), mime: 'audio/wav' }; }) } as any;
    const scheduler = { acquire: jest.fn(async () => { events.push('acquire'); return { release: async () => { events.push('release'); } }; }) } as any;
    const runs = {
      begin: jest.fn(async () => ({ replay: false, run: { id: 'run', provider: 'cosyvoice3' } })),
      patch: jest.fn(async () => undefined), finish: jest.fn(async () => ({ id: 'run', status: 'succeeded', outputAssetIds: ['asset'] })),
    } as any;
    const assets = { read: jest.fn(async () => reference), saveGenerated: jest.fn(async () => ({ id: 'asset' })) } as any;
    const canvas = { assertWriteAccess: jest.fn(async () => undefined) } as any;
    const controller = new TtsController(client, scheduler, runs, assets, canvas, {} as any);
    const result = await controller.run({ provider: 'cosyvoice3', text: '测试配音', referenceText: '参考文本', referenceAssetId: 'voice', canvasId: 'canvas', ...control });
    expect(events).toEqual(['acquire', 'infer', 'release']);
    expect(result.asset).toEqual({ assetId: 'asset', url: '/api/assets/asset', kind: 'audio' });
    expect(assets.saveGenerated).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio', mime: 'audio/wav', canvasId: 'canvas' }));
  });

  it('generates speech segments serially, never sends tags, and saves one final asset', async () => {
    const texts: string[] = [];
    const client = { infer: jest.fn(async (_provider: string, input: any) => { texts.push(input.text); return { buffer: pcmWav(), mime: 'audio/wav' }; }) } as any;
    const scheduler = { acquire: jest.fn(async () => ({ release: jest.fn(async () => undefined) })) } as any;
    const runs = { registerCancelHandler: jest.fn(), begin: jest.fn(async () => ({ replay: false, run: { id: 'run' } })), patch: jest.fn(async (_id, patch) => ({ id: 'run', ...patch })), finish: jest.fn(async (_id, status, ids) => ({ id: 'run', status, outputAssetIds: ids })) } as any;
    const assets = { read: jest.fn(async () => reference), saveGenerated: jest.fn(async () => ({ id: 'final' })) } as any;
    const controller = new TtsController(client, scheduler, runs, assets, { assertWriteAccess: jest.fn() } as any, {} as any); controller.onModuleInit();
    const result = await controller.run({ provider: 'indextts2', text: '第一句。<pause ms="800"/>第二句。<pause ms="200"/><pause ms="300"/>第三句。', referenceAssetId: 'voice', canvasId: 'canvas', ...control });
    expect(texts).toEqual(['第一句。', '第二句。', '第三句。']);
    expect(assets.saveGenerated).toHaveBeenCalledTimes(1);
    expect(result.run.outputAssetIds).toEqual(['final']);
    const snapshots = runs.patch.mock.calls.map((call: any[]) => call[1].inputSnapshot).filter(Boolean);
    expect(snapshots.at(-1)).toMatchObject({ pauseSyntaxVersion: 1, segments: [{ type: 'speech' }, { type: 'silence', durationMs: 800 }, { type: 'speech' }, { type: 'silence', durationMs: 500 }, { type: 'speech' }], execution: { policy: 'speech-segment-serial-v1', stage: 'succeeded', finalAssetId: 'final' } });
  });

  it('requires a transcript for CosyVoice but not IndexTTS2', async () => {
    const controller = new TtsController({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(controller.run({ provider: 'cosyvoice3', text: '测试', referenceAssetId: 'voice', canvasId: 'canvas', ...control })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels at a speech boundary, releases the outer lease, and exposes no partial asset', async () => {
    let cancel!: (runId: string) => Promise<unknown>; let calls = 0;
    const released = jest.fn(async () => undefined);
    const runs = { registerCancelHandler: jest.fn((_provider, handler) => { cancel = handler; }), get: jest.fn(async () => ({ id: 'run', status: 'running' })), begin: jest.fn(async () => ({ replay: false, run: { id: 'run' } })), patch: jest.fn(async (_id, patch) => ({ id: 'run', ...patch })), finish: jest.fn(async (_id, status, ids, error) => ({ id: 'run', status, outputAssetIds: ids, error })) } as any;
    const client = { infer: jest.fn(async () => { calls += 1; if (calls === 1) await cancel('run'); return { buffer: pcmWav(), mime: 'audio/wav' }; }) } as any;
    const assets = { read: jest.fn(async () => reference), saveGenerated: jest.fn() } as any;
    const controller = new TtsController(client, { acquire: jest.fn(async () => ({ release: released })) } as any, runs, assets, { assertWriteAccess: jest.fn() } as any, {} as any); controller.onModuleInit();
    await expect(controller.run({ provider: 'indextts2', text: '第一句<pause ms="500"/>第二句', referenceAssetId: 'voice', canvasId: 'canvas', ...control })).rejects.toThrow('安全片段边界取消');
    expect(client.infer).toHaveBeenCalledTimes(1); expect(assets.saveGenerated).not.toHaveBeenCalled(); expect(released).toHaveBeenCalledTimes(1);
    expect(runs.finish).toHaveBeenCalledWith('run', 'cancelled', [], expect.objectContaining({ code: 'RUN_CANCELLED' }));
  });

  it('marks final persistence failure without publishing a candidate and still releases the lease', async () => {
    const released = jest.fn(async () => undefined);
    const runs = { begin: jest.fn(async () => ({ replay: false, run: { id: 'run' } })), patch: jest.fn(async () => ({ id: 'run' })), finish: jest.fn(async () => ({ id: 'run' })) } as any;
    const controller = new TtsController({ infer: jest.fn(async () => ({ buffer: pcmWav(), mime: 'audio/wav' })) } as any, { acquire: jest.fn(async () => ({ release: released })) } as any, runs, { read: jest.fn(async () => reference), saveGenerated: jest.fn(async () => { throw new Error('disk full'); }) } as any, { assertWriteAccess: jest.fn() } as any, {} as any);
    await expect(controller.run({ provider: 'indextts2', text: '测试', referenceAssetId: 'voice', canvasId: 'canvas', ...control })).rejects.toThrow('disk full');
    expect(runs.finish).toHaveBeenCalledWith('run', 'failed', [], expect.objectContaining({ code: 'TTS_RUN_FAILED' })); expect(released).toHaveBeenCalledTimes(1);
  });
});

function pcmWav() { const pcm = Buffer.alloc(4800); const out = Buffer.alloc(44 + pcm.length); out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(24000, 24); out.writeUInt32LE(48000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44); return out; }
