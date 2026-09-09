import { BadRequestException } from '@nestjs/common';
import { join } from 'path';
import { TtsController } from './tts.controller';

describe('TtsController', () => {
  const control = { leaseToken: 'token', leaseEpoch: 1, expectedRevision: 0 };
  const reference = { asset: { id: 'voice', canvasId: 'canvas', kind: 'audio' }, absPath: join(__dirname, '..', '..', 'tts-worker', 'requirements-cosyvoice-windows.txt') };

  it('runs synthesis under a GPU lease and persists the audio candidate', async () => {
    const events: string[] = [];
    const client = { infer: jest.fn(async () => { events.push('infer'); return { buffer: Buffer.from('wav'), mime: 'audio/wav' }; }) } as any;
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

  it('requires a transcript for CosyVoice but not IndexTTS2', async () => {
    const controller = new TtsController({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(controller.run({ provider: 'cosyvoice3', text: '测试', referenceAssetId: 'voice', canvasId: 'canvas', ...control })).rejects.toBeInstanceOf(BadRequestException);
  });
});
