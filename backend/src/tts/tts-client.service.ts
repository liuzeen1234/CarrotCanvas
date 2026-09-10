import { BadGatewayException, Injectable } from '@nestjs/common';
import { LocalComputeProvider } from '../gpu-scheduler/gpu-resource-lease.entity';

export const TTS_PROVIDERS = ['cosyvoice3', 'indextts2', 'qwen3tts'] as const;
export type TtsProvider = typeof TTS_PROVIDERS[number];

@Injectable()
export class TtsClientService {
  private url(provider: TtsProvider) {
    const configured = provider === 'cosyvoice3' ? process.env.COSYVOICE3_URL : provider === 'indextts2' ? process.env.INDEXTTS2_URL : process.env.QWEN3TTS_URL;
    const fallback = provider === 'cosyvoice3' ? 'http://127.0.0.1:50000' : provider === 'indextts2' ? 'http://127.0.0.1:50001' : 'http://127.0.0.1:50002';
    return (configured || fallback).replace(/\/+$/, '');
  }

  async health(provider: TtsProvider) {
    return this.json(provider, '/health', { method: 'GET' });
  }

  async prepare(provider: TtsProvider) {
    await this.json(provider, '/load', { method: 'POST' });
  }

  async release(provider: TtsProvider) {
    await this.json(provider, '/unload', { method: 'POST' });
  }

  async infer(provider: TtsProvider, input: Record<string, unknown>): Promise<{ buffer: Buffer; mime: string }> {
    const response = await this.request(provider, '/infer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    return { buffer: Buffer.from(await response.arrayBuffer()), mime: response.headers.get('content-type') || 'audio/wav' };
  }

  private async json(provider: TtsProvider, path: string, init: RequestInit) {
    const response = await this.request(provider, path, init);
    return response.json();
  }

  private async request(provider: TtsProvider, path: string, init: RequestInit) {
    try {
      const response = await fetch(`${this.url(provider)}${path}`, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response;
    } catch (error) {
      throw new BadGatewayException({ code: 'TTS_PROVIDER_UNAVAILABLE', provider, message: (error as Error).message });
    }
  }
}
