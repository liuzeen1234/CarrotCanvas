import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { audioProfile, decodeWav, pauseTiming, pitchEnergy } from './wav-analysis';

function pcm16Wav(samples: number[], rate = 16_000) {
  const data = Buffer.alloc(samples.length * 2); samples.forEach((sample, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2));
  const out = Buffer.alloc(44 + data.length); out.write('RIFF', 0); out.writeUInt32LE(36 + data.length, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
}

describe('WAV objective analysis', () => {
  it('measures profile, pauses and pitch without inventing perceptual scores', async () => {
    const rate = 16_000; const samples = Array.from({ length: rate }, (_, i) => i < rate * .25 ? 0 : .3 * Math.sin(2 * Math.PI * 200 * i / rate));
    const path = join(tmpdir(), `carrot-eval-${process.pid}.wav`); await fs.writeFile(path, pcm16Wav(samples, rate));
    try {
      const wav = await decodeWav(path); const profile = audioProfile(wav); const pauses = pauseTiming(wav); const pitch = pitchEnergy(wav);
      expect(profile).toMatchObject({ durationMs: 1000, sampleRate: rate, channels: 1 });
      expect(pauses.pauseCount).toBeGreaterThan(0); expect(pauses.silenceRatio).toBeGreaterThan(.15);
      expect(pitch.meanF0Hz).toBeGreaterThan(190); expect(pitch.meanF0Hz).toBeLessThan(210);
    } finally { await fs.rm(path, { force: true }); }
  });
});
