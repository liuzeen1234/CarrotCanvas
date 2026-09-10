import { existsSync } from 'fs';
import { resolve } from 'path';
import type { TtsProvider } from './tts-client.service';

export interface TtsVoicePreset {
  id: string;
  name: string;
  description: string;
  providers: TtsProvider[];
  referenceText?: string;
  absPath?: string;
  nativeSpeaker?: string;
}

const root = resolve(__dirname, '..', '..', '..');

const presets: TtsVoicePreset[] = [
  {
    id: 'cosyvoice-demo-female',
    name: '清亮女声',
    description: '自然、清晰，适合旁白和日常对白',
    providers: ['cosyvoice3', 'indextts2'],
    referenceText: '希望你以后能够做的比我还好呦。',
    absPath: resolve(root, 'backend', 'data', 'tts-runtime', 'CosyVoice', 'asset', 'zero_shot_prompt.wav'),
  },
];

const qwenVoices: Array<[string, string, string, string]> = [
  ['Vivian', '明亮女声', '年轻明亮，略带锐利感', '中文'],
  ['Serena', '温柔女声', '年轻、温暖、柔和', '中文'],
  ['Uncle_Fu', '浑厚男声', '成熟低沉、音色醇厚', '中文'],
  ['Dylan', '北京青年男声', '清晰自然，带北京口音', '中文'],
  ['Eric', '成都青年男声', '活泼、略带沙哑明亮感', '中文'],
  ['Ryan', '律动英语男声', '充满活力与节奏感', '英语'],
  ['Aiden', '阳光英语男声', '清晰、阳光的美式男声', '英语'],
  ['Ono_Anna', '俏皮日语女声', '轻快灵动、俏皮', '日语'],
  ['Sohee', '温暖韩语女声', '温暖且富有情感', '韩语'],
];

presets.push(...qwenVoices.map(([nativeSpeaker, name, description, language]) => ({
  id: `qwen-${nativeSpeaker.toLowerCase()}`, name, description: `${description} · ${language}`,
  providers: ['qwen3tts' as const], nativeSpeaker,
})));

export function listAvailableVoicePresets() {
  return presets.filter((preset) => preset.nativeSpeaker || (preset.absPath && existsSync(preset.absPath)));
}

export function getVoicePreset(id: string, provider: TtsProvider) {
  return listAvailableVoicePresets().find((preset) => preset.id === id && preset.providers.includes(provider)) ?? null;
}

export function publicVoicePreset(preset: TtsVoicePreset) {
  const { absPath: _absPath, referenceText: _referenceText, nativeSpeaker: _nativeSpeaker, ...value } = preset;
  return value;
}
