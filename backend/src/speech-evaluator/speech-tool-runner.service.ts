import { Injectable } from '@nestjs/common';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export type ModelTool = 'funasr' | 'wespeaker' | 'utmosv2';
export interface ModelToolItem { path: string; referencePath?: string; targetText?: string }
export interface ModelToolEvent { index: number; status: 'started' | 'completed'; result?: Record<string, unknown> }
export interface ModelToolRunResult { items: Record<string, unknown>[]; cancelled: boolean }

@Injectable()
export class SpeechToolRunnerService {
  private readonly root = resolve(__dirname, '..', '..', '..');
  private readonly runtime = join(this.root, 'backend', 'data', 'speech-evaluator-runtime');
  private readonly python = join(this.runtime, 'evaluator-env', 'Scripts', 'python.exe');
  private readonly worker = join(this.root, 'backend', 'speech-evaluator-worker', 'tool.py');
  private readonly cancellations = join(this.runtime, 'cancellations');
  private readonly workerState = join(this.runtime, 'active-worker.json');
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  available() { return existsSync(this.python) && existsSync(this.worker); }

  async prepare() {
    if (!existsSync(this.workerState)) return;
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(readFileSync(this.workerState, 'utf8')) as Record<string, unknown>; }
    catch { /* malformed state is intentionally treated as unprovable below */ }
    const pid = Number(state.pid);
    if (Number.isInteger(pid) && pid > 0 && !this.isPidAlive(pid)) {
      rmSync(this.workerState, { force: true });
      return;
    }
    const error = new Error('无法证明上次 speech-evaluator 子进程已经释放') as Error & { details?: unknown };
    error.details = {
      code: 'PROVIDER_STATE_UNCONFIRMED', provider: 'speech-evaluator', pid: Number.isInteger(pid) ? pid : null,
      ports: [], rssBytes: null, privateBytes: null, vramBytes: null, recordedState: state,
    };
    throw error;
  }

  cancel(runId: string) {
    mkdirSync(this.cancellations, { recursive: true });
    writeFileSync(join(this.cancellations, runId), '', { flag: 'w' });
  }

  clearCancellation(runId: string) { rmSync(this.cancellationFile(runId), { force: true }); }

  cancellationFile(runId: string) { return join(this.cancellations, runId); }

  async release() {
    const child = this.activeChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this.activeChild = null; return; }
    const attempts: Array<Record<string, unknown>> = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const signaled = child.kill();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      attempts.push({ attempt, pid: child.pid ?? null, signaled, exited: child.exitCode !== null || child.signalCode !== null, ports: [], rssBytes: null, privateBytes: null, vramBytes: null });
      if (child.exitCode !== null || child.signalCode !== null) { this.activeChild = null; return; }
    }
    const error = new Error('speech-evaluator 子进程连续 3 次无法完全释放') as Error & { details?: unknown };
    error.details = { code: 'PROVIDER_RELEASE_FAILED', provider: 'speech-evaluator', attempts };
    throw error;
  }

  async run(tool: ModelTool, items: ModelToolItem[], runId: string, onEvent: (event: ModelToolEvent) => Promise<void>): Promise<ModelToolRunResult> {
    if (!this.available()) throw new Error('speech-evaluator 独立 Python 环境尚未部署');
    for (const dir of ['modelscope-cache', 'wespeaker-models', 'huggingface-cache', 'temp']) mkdirSync(join(this.runtime, dir), { recursive: true });
    return new Promise<ModelToolRunResult>((resolvePromise, reject) => {
      const device = tool === 'wespeaker' ? 'cpu' : 'cuda:0';
      const child = spawn(this.python, [this.worker, '--tool', tool, '--device', device, '--cancel-file', this.cancellationFile(runId)], {
        cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
          ...process.env, MODELSCOPE_CACHE: join(this.runtime, 'modelscope-cache'), WESPEAKER_HOME: join(this.runtime, 'wespeaker-models'),
          HF_HOME: join(this.runtime, 'huggingface-cache'), TMP: join(this.runtime, 'temp'), TEMP: join(this.runtime, 'temp'),
          UTMOSV2_CHECKPOINT: join(this.runtime, 'utmosv2', 'fold0_s42_best_model.pth'),
          PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
          HF_HUB_OFFLINE: '1',
          OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', TOKENIZERS_PARALLELISM: 'false',
        },
      });
      this.activeChild = child;
      writeFileSync(this.workerState, JSON.stringify({ pid: child.pid ?? null, runId, tool, worker: this.worker, startedAt: Date.now() }), { flag: 'w' });
      let stdout = ''; let stderr = ''; let lineBuffer = ''; let eventChain = Promise.resolve();
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString(); stdout += text; lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('CARROT_SPEECH_EVALUATOR_EVENT=')) {
          const event = JSON.parse(line.slice('CARROT_SPEECH_EVALUATOR_EVENT='.length)) as ModelToolEvent;
          eventChain = eventChain.then(() => onEvent(event));
        }
      }); child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject); child.once('exit', (code) => {
        if (this.activeChild === child) this.activeChild = null;
        rmSync(this.workerState, { force: true });
        void eventChain.then(() => {
          if (code !== 0) throw new Error(`${tool} worker 退出码 ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`);
          const marker = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('CARROT_SPEECH_EVALUATOR_RESULT='));
          if (!marker) throw new Error(`${tool} worker 未返回结构化结果: ${stderr.slice(-2000) || stdout.slice(-2000)}`);
          const parsed = JSON.parse(marker.slice('CARROT_SPEECH_EVALUATOR_RESULT='.length));
          resolvePromise({ items: (parsed.items ?? []) as Record<string, unknown>[], cancelled: parsed.cancelled === true });
        }).catch(reject);
      });
      child.stdin.end(JSON.stringify({ items }));
    });
  }

  private isPidAlive(pid: number) {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
}
