import { promises as fs } from 'fs';

export interface DecodedWav { sampleRate: number; channels: number; samples: Float64Array; durationMs: number }

export async function decodeWav(path: string): Promise<DecodedWav> {
  const buffer = await fs.readFile(path);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('仅支持 RIFF/WAVE 音频');
  let offset = 12; let format: Buffer | null = null; let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    if (id === 'fmt ') format = chunk; if (id === 'data') data = chunk;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data || format.length < 16) throw new Error('WAV 缺少 fmt 或 data 块');
  const audioFormat = format.readUInt16LE(0); const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4); const bits = format.readUInt16LE(14);
  if (!channels || !sampleRate || ![1, 3].includes(audioFormat)) throw new Error(`不支持的 WAV 格式 ${audioFormat}`);
  const bytes = bits / 8; const frames = Math.floor(data.length / (bytes * channels)); const samples = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * bytes;
      if (audioFormat === 3 && bits === 32) sum += data.readFloatLE(at);
      else if (bits === 16) sum += data.readInt16LE(at) / 32768;
      else if (bits === 24) sum += data.readIntLE(at, 3) / 8388608;
      else if (bits === 32) sum += data.readInt32LE(at) / 2147483648;
      else throw new Error(`不支持的 PCM 位深 ${bits}`);
    }
    samples[frame] = sum / channels;
  }
  return { sampleRate, channels, samples, durationMs: frames / sampleRate * 1000 };
}

export function audioProfile(wav: DecodedWav) {
  let sumSquares = 0; let peak = 0; let clipped = 0;
  for (const value of wav.samples) { const abs = Math.abs(value); peak = Math.max(peak, abs); sumSquares += value * value; if (abs >= 0.999) clipped += 1; }
  const rms = Math.sqrt(sumSquares / Math.max(1, wav.samples.length));
  return { durationMs: round(wav.durationMs, 1), sampleRate: wav.sampleRate, channels: wav.channels,
    peak: round(peak, 6), rms: round(rms, 6), rmsDbfs: round(20 * Math.log10(Math.max(rms, 1e-9)), 2), clippedSampleRatio: round(clipped / Math.max(1, wav.samples.length), 8) };
}

export function pauseTiming(wav: DecodedWav) {
  const frameSize = Math.max(1, Math.round(wav.sampleRate * 0.02)); const energies: number[] = [];
  for (let start = 0; start < wav.samples.length; start += frameSize) {
    let sum = 0; const end = Math.min(wav.samples.length, start + frameSize);
    for (let i = start; i < end; i += 1) sum += wav.samples[i] * wav.samples[i];
    energies.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const sorted = [...energies].sort((a, b) => a - b); const p90 = sorted[Math.floor(sorted.length * .9)] ?? 0;
  const threshold = Math.max(0.001, p90 * 0.08); const segments: Array<{ startMs: number; endMs: number; durationMs: number }> = [];
  let start: number | null = null;
  for (let i = 0; i <= energies.length; i += 1) {
    const silent = i < energies.length && energies[i] <= threshold;
    if (silent && start === null) start = i;
    if (!silent && start !== null) { const duration = (i - start) * 20; if (duration >= 120) segments.push({ startMs: start * 20, endMs: Math.min(wav.durationMs, i * 20), durationMs: duration }); start = null; }
  }
  const silenceMs = segments.reduce((sum, item) => sum + item.durationMs, 0);
  return { method: 'adaptive-rms-v1', thresholdRms: round(threshold, 6), pauseCount: segments.length,
    silenceMs: round(silenceMs, 1), silenceRatio: round(silenceMs / Math.max(1, wav.durationMs), 4), pauses: segments };
}

export function pitchEnergy(wav: DecodedWav) {
  const frameSize = Math.round(wav.sampleRate * 0.04); const hop = Math.round(wav.sampleRate * 0.02);
  const minLag = Math.floor(wav.sampleRate / 500); const maxLag = Math.ceil(wav.sampleRate / 60); const pitches: number[] = [];
  for (let start = 0; start + frameSize <= wav.samples.length; start += hop) {
    let energy = 0; for (let i = start; i < start + frameSize; i += 1) energy += wav.samples[i] * wav.samples[i];
    if (Math.sqrt(energy / frameSize) < 0.008) continue;
    let bestLag = 0; let best = 0;
    for (let lag = minLag; lag <= maxLag && lag < frameSize; lag += 1) {
      let corr = 0; let a = 0; let b = 0;
      for (let i = lag; i < frameSize; i += 1) { const x = wav.samples[start + i]; const y = wav.samples[start + i - lag]; corr += x * y; a += x * x; b += y * y; }
      const normalized = corr / Math.sqrt(Math.max(1e-12, a * b)); if (normalized > best) { best = normalized; bestLag = lag; }
    }
    if (best >= 0.55 && bestLag) pitches.push(wav.sampleRate / bestLag);
  }
  pitches.sort((a, b) => a - b); const mean = pitches.reduce((a, b) => a + b, 0) / Math.max(1, pitches.length);
  const percentile = (p: number) => pitches[Math.min(pitches.length - 1, Math.floor(pitches.length * p))] ?? null;
  const p10 = percentile(.1); const p90 = percentile(.9);
  return { method: 'normalized-autocorrelation-v1', voicedFrameCount: pitches.length, meanF0Hz: pitches.length ? round(mean, 2) : null,
    p10F0Hz: p10 === null ? null : round(p10, 2), p90F0Hz: p90 === null ? null : round(p90, 2),
    rangeSemitones: p10 && p90 ? round(12 * Math.log2(p90 / p10), 2) : null };
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
