import { BadRequestException } from '@nestjs/common';

export const PAUSE_SYNTAX_VERSION = 1;
export const MIN_PAUSE_MS = 100;
export const MAX_PAUSE_MS = 10_000;

export type PausePlanSegment =
  | { type: 'speech'; text: string }
  | { type: 'silence'; durationMs: number };

export function parsePausePlan(input: string): PausePlanSegment[] {
  if (typeof input !== 'string' || !input.trim()) invalid('配音文本不能为空');
  const segments: PausePlanSegment[] = [];
  const tag = /<pause\b([^>]*)\/?\s*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(input))) {
    appendSpeech(segments, input.slice(cursor, match.index));
    if (!/\/\s*>$/.test(match[0])) invalid('pause 标签必须使用自闭合格式 <pause ms="N"/>');
    const attrs = match[1].replace(/\/\s*$/, '').trim();
    const value = /^ms\s*=\s*["'](\d+)["']$/i.exec(attrs)?.[1];
    if (!value) invalid('pause 标签只接受整数毫秒属性，例如 <pause ms="800"/>');
    const durationMs = Number(value);
    if (durationMs < MIN_PAUSE_MS || durationMs > MAX_PAUSE_MS) invalid(`pause 时长必须在 ${MIN_PAUSE_MS}–${MAX_PAUSE_MS}ms`);
    const previous = segments.at(-1);
    if (previous?.type === 'silence') {
      const total = previous.durationMs + durationMs;
      if (total > MAX_PAUSE_MS) invalid(`连续 pause 累计时长不得超过 ${MAX_PAUSE_MS}ms`);
      previous.durationMs = total;
    } else segments.push({ type: 'silence', durationMs });
    cursor = tag.lastIndex;
  }
  appendSpeech(segments, input.slice(cursor));
  const leftover = input.replace(/<pause\b([^>]*)\/?\s*>/gi, '');
  if (/<\/?pause\b/i.test(leftover)) invalid('pause 标签未闭合或格式不合法');
  if (/<[^>]*\bpause\b[^>]*>/i.test(leftover)) invalid('未知 pause 标签或属性');
  if (/<[^>]+>/.test(leftover)) invalid('不支持的标签；当前只接受 <pause ms="N"/>');
  if (!segments.some((item) => item.type === 'speech')) invalid('纯停顿文本没有可生成的有效台词');
  return segments;
}

function appendSpeech(segments: PausePlanSegment[], text: string) {
  const normalized = text.trim();
  if (normalized) segments.push({ type: 'speech', text: normalized });
}

function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_PAUSE_SYNTAX', message });
}

export interface WavFormat { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number; }
export interface DecodedPcmWav { format: WavFormat; formatChunk: Buffer; pcm: Buffer; durationMs: number; }

export function decodePcmWav(buffer: Buffer): DecodedPcmWav {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('TTS 片段不是有效 WAV');
  let offset = 12; let formatChunk: Buffer | null = null; let pcm: Buffer | null = null; let format: WavFormat | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4); const start = offset + 8; const end = start + size;
    if (end > buffer.length) throw new Error('WAV chunk 长度非法');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt chunk 不完整');
      formatChunk = Buffer.from(buffer.subarray(start, end));
      format = { audioFormat: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8), blockAlign: buffer.readUInt16LE(start + 12), bitsPerSample: buffer.readUInt16LE(start + 14) };
    } else if (id === 'data') pcm = Buffer.from(buffer.subarray(start, end));
    offset = end + (size % 2);
  }
  if (!format || !formatChunk || !pcm || ![1, 3].includes(format.audioFormat) || !format.blockAlign || !format.byteRate) throw new Error('仅支持 PCM/IEEE-float WAV 片段');
  return { format, formatChunk, pcm, durationMs: pcm.length / format.byteRate * 1000 };
}

export function concatenatePcmWav(parts: Array<{ type: 'speech'; wav: Buffer } | { type: 'silence'; durationMs: number }>) {
  const decoded = parts.filter((part): part is { type: 'speech'; wav: Buffer } => part.type === 'speech').map((part) => decodePcmWav(part.wav));
  if (!decoded.length) throw new Error('没有可拼接的语音片段');
  const base = decoded[0]; let speechIndex = 0;
  for (const item of decoded.slice(1)) if (!sameFormat(base.format, item.format) || !base.formatChunk.equals(item.formatChunk)) throw new Error('TTS 片段 WAV 格式不一致，无法无损拼接');
  const audit: Array<Record<string, unknown>> = [];
  const chunks = parts.map((part, position) => {
    if (part.type === 'speech') { const item = decoded[speechIndex++]; audit.push({ position, type: 'speech', durationMs: round(item.durationMs), bytes: item.pcm.length }); return item.pcm; }
    const frames = Math.round(part.durationMs * base.format.sampleRate / 1000); const pcm = Buffer.alloc(frames * base.format.blockAlign);
    audit.push({ position, type: 'silence', targetDurationMs: part.durationMs, actualDurationMs: round(frames / base.format.sampleRate * 1000), frames }); return pcm;
  });
  const pcm = Buffer.concat(chunks); const fmtSize = base.formatChunk.length; const pad = pcm.length % 2; const output = Buffer.alloc(12 + 8 + fmtSize + (fmtSize % 2) + 8 + pcm.length + pad);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8); output.write('fmt ', 12); output.writeUInt32LE(fmtSize, 16); base.formatChunk.copy(output, 20);
  const dataOffset = 20 + fmtSize + (fmtSize % 2); output.write('data', dataOffset); output.writeUInt32LE(pcm.length, dataOffset + 4); pcm.copy(output, dataOffset + 8);
  return { buffer: output, format: base.format, durationMs: round(pcm.length / base.format.byteRate * 1000), segments: audit, toolVersion: 'carrot-pcm-wav-concat-v1' };
}

function sameFormat(a: WavFormat, b: WavFormat) { return a.audioFormat === b.audioFormat && a.channels === b.channels && a.sampleRate === b.sampleRate && a.blockAlign === b.blockAlign && a.bitsPerSample === b.bitsPerSample; }
function round(value: number) { return Math.round(value * 10) / 10; }
