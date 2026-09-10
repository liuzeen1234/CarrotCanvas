import { existsSync } from 'fs';
import { resolve } from 'path';
import type { TtsProvider } from './tts-client.service';

export interface TtsVoicePreset {
  id: string;
  name: string;
  description: string;
  providers: TtsProvider[];
  referenceText: string;
  absPath: string;
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

export function listAvailableVoicePresets() {
  return presets.filter((preset) => existsSync(preset.absPath));
}

export function getVoicePreset(id: string, provider: TtsProvider) {
  return listAvailableVoicePresets().find((preset) => preset.id === id && preset.providers.includes(provider)) ?? null;
}

export function publicVoicePreset(preset: TtsVoicePreset) {
  const { absPath: _absPath, referenceText: _referenceText, ...value } = preset;
  return value;
}
