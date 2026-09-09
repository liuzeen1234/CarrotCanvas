import { BadRequestException } from '@nestjs/common';
import { concatenatePcmWav, parsePausePlan } from './pause-plan';

describe('pause plan', () => {
  it.each([
    ['单段', [{ type: 'speech', text: '单段' }]],
    ['<pause ms="100"/>开头', [{ type: 'silence', durationMs: 100 }, { type: 'speech', text: '开头' }]],
    ['结尾<pause ms="10000"/>', [{ type: 'speech', text: '结尾' }, { type: 'silence', durationMs: 10000 }]],
    ['甲。<pause ms="300"/><pause ms="400"/>乙！', [{ type: 'speech', text: '甲。' }, { type: 'silence', durationMs: 700 }, { type: 'speech', text: '乙！' }]],
    ['甲\n <pause ms="800"/> \n乙', [{ type: 'speech', text: '甲' }, { type: 'silence', durationMs: 800 }, { type: 'speech', text: '乙' }]],
  ])('normalizes %s', (input, expected) => expect(parsePausePlan(input)).toEqual(expected));

  it.each(['<pause ms="99"/>甲', '甲<pause ms="10001"/>', '<pause ms="100"/>', '甲<pause ms="x"/>乙', '甲<pause seconds="1"/>乙', '甲<pause ms="200">乙', '甲<pause ms="200"乙', '甲<break ms="200"/>乙', '甲<pause ms="6000"/><pause ms="5000"/>乙'])('rejects invalid syntax: %s', (input) => expect(() => parsePausePlan(input)).toThrow(BadRequestException));

  it('inserts sample-accurate silence without lossy encoding', () => {
    const wav = pcmWav(24_000, Buffer.alloc(2_400 * 2, 1));
    const result = concatenatePcmWav([{ type: 'speech', wav }, { type: 'silence', durationMs: 805 }, { type: 'speech', wav }]);
    expect(result.format).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(result.segments[1]).toMatchObject({ targetDurationMs: 805, actualDurationMs: 805, frames: 19_320 });
    expect(result.durationMs).toBe(1005);
  });
});

function pcmWav(sampleRate: number, pcm: Buffer) {
  const out = Buffer.alloc(44 + pcm.length); out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44); return out;
}
