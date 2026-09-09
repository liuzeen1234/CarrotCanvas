import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, openSync } from 'fs';
import { join, resolve } from 'path';
import type { TtsProvider } from './tts-client.service';

export interface ProviderStopAttempt {
  attempt: number; pid: number | null; rssBytes: number | null;
  cudaReservedBytes: number | null; portListening: boolean; outcome: string;
}

@Injectable()
export class TtsProcessManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TtsProcessManagerService.name);
  private readonly children = new Map<TtsProvider, ChildProcess>();
  private readonly root = resolve(__dirname, '..', '..', '..');
  private readonly worker = join(this.root, 'backend', 'tts-worker', 'server.py');
  private readonly runtime = join(this.root, 'backend', 'data', 'tts-runtime');
  private readonly logs = join(this.root, 'backend', 'data', 'tts-logs');

  async onModuleInit() {
    if (!this.managed) return;
    mkdirSync(this.logs, { recursive: true });
    await Promise.allSettled((['cosyvoice3', 'indextts2'] as const).map((provider) => this.stop(provider)));
  }

  async ensureRunning(provider: TtsProvider) {
    const existing = await this.health(provider);
    if (existing?.ok) return existing;
    if (!this.managed) throw new Error(`${provider} 未运行，且 CARROT_MANAGE_TTS=false`);
    const config = this.config(provider);
    if (!existsSync(config.python) || !existsSync(this.worker)) throw new Error(`${provider} 本地运行环境不存在`);
    mkdirSync(this.logs, { recursive: true });
    const out = openSync(join(this.logs, `${provider}.stdout.log`), 'a');
    const err = openSync(join(this.logs, `${provider}.stderr.log`), 'a');
    const child = spawn(config.python, [this.worker, '--provider', provider, '--port', String(config.port)], {
      cwd: this.root, windowsHide: true, stdio: ['ignore', out, err],
    });
    child.once('exit', () => { if (this.children.get(provider) === child) this.children.delete(provider); });
    child.on('error', (error) => this.logger.error(`${provider} 启动失败：${error.message}`));
    this.children.set(provider, child);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const health = await this.health(provider);
      if (health?.ok) return health;
      if (child.exitCode !== null) throw new Error(`${provider} worker 提前退出，exitCode=${child.exitCode}`);
      await delay(250);
    }
    throw new Error(`${provider} worker 启动后 30 秒内未通过健康检查`);
  }

  async stop(provider: TtsProvider): Promise<{ stopped: true; attempts: ProviderStopAttempt[] }> {
    const attempts: ProviderStopAttempt[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = await this.health(provider);
      if (!before) return { stopped: true, attempts };
      const pid = numberOrNull(before.pid);
      let outcome = 'shutdown requested';
      try { await fetch(`${this.url(provider)}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3_000) }); }
      catch (error) { outcome = `shutdown error: ${(error as Error).message}`; }
      if (await this.waitStopped(provider, pid, 5_000)) {
        attempts.push(this.attempt(attempt, before, false, outcome)); this.children.delete(provider);
        return { stopped: true, attempts };
      }
      if (pid && this.isLocal(provider)) {
        try { process.kill(pid, attempt < 3 ? 'SIGTERM' : 'SIGKILL'); outcome += `; sent ${attempt < 3 ? 'SIGTERM' : 'SIGKILL'}`; }
        catch (error) { outcome += `; kill error: ${(error as Error).message}`; }
      }
      const stopped = await this.waitStopped(provider, pid, 3_000);
      attempts.push(this.attempt(attempt, before, !stopped, outcome));
      if (stopped) { this.children.delete(provider); return { stopped: true, attempts }; }
    }
    const error = new Error(`${provider} 连续 3 次未能结束进程，已中断 Provider 切换`);
    (error as Error & { details?: unknown }).details = { code: 'PROVIDER_RELEASE_FAILED', provider, attempts };
    throw error;
  }

  async health(provider: TtsProvider): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${this.url(provider)}/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok ? await response.json() as Record<string, unknown> : null;
    } catch { return null; }
  }

  async onModuleDestroy() {
    if (this.managed) await Promise.allSettled((['cosyvoice3', 'indextts2'] as const).map((provider) => this.stop(provider)));
  }

  private get managed() { return process.env.CARROT_MANAGE_TTS !== 'false'; }
  private config(provider: TtsProvider) {
    return provider === 'cosyvoice3'
      ? { port: 50000, python: join(this.runtime, 'cosyvoice-env', 'Scripts', 'python.exe') }
      : { port: 50001, python: join(this.runtime, 'indextts-env', 'Scripts', 'python.exe') };
  }
  private url(provider: TtsProvider) { return provider === 'cosyvoice3' ? 'http://127.0.0.1:50000' : 'http://127.0.0.1:50001'; }
  private isLocal(provider: TtsProvider) {
    const configured = provider === 'cosyvoice3' ? process.env.COSYVOICE3_URL : process.env.INDEXTTS2_URL;
    return !configured || /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(configured);
  }
  private async waitStopped(provider: TtsProvider, pid: number | null, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!await this.health(provider) && !this.pidAlive(pid)) return true;
      await delay(200);
    }
    return !await this.health(provider) && !this.pidAlive(pid);
  }
  private pidAlive(pid: number | null) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  private attempt(attempt: number, health: Record<string, unknown>, portListening: boolean, outcome: string): ProviderStopAttempt {
    return { attempt, pid: numberOrNull(health.pid), rssBytes: numberOrNull(health.rssBytes), cudaReservedBytes: numberOrNull(health.cudaReservedBytes), portListening, outcome };
  }
}

function numberOrNull(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
