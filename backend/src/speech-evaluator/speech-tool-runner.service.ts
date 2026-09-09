import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

export type ModelTool = 'funasr' | 'wespeaker' | 'utmosv2';
export interface ModelToolItem { path: string; referencePath?: string; targetText?: string }

@Injectable()
export class SpeechToolRunnerService {
  private readonly root = resolve(__dirname, '..', '..', '..');
  private readonly runtime = join(this.root, 'backend', 'data', 'speech-evaluator-runtime');
  private readonly python = join(this.runtime, 'evaluator-env', 'Scripts', 'python.exe');
  private readonly worker = join(this.root, 'backend', 'speech-evaluator-worker', 'tool.py');

  available() { return existsSync(this.python) && existsSync(this.worker); }

  async run(tool: ModelTool, items: ModelToolItem[]) {
    if (!this.available()) throw new Error('speech-evaluator 独立 Python 环境尚未部署');
    for (const dir of ['modelscope-cache', 'wespeaker-models', 'huggingface-cache', 'temp']) mkdirSync(join(this.runtime, dir), { recursive: true });
    return new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
      const device = tool === 'wespeaker' ? 'cpu' : 'cuda:0';
      const child = spawn(this.python, [this.worker, '--tool', tool, '--device', device], {
        cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
          ...process.env, MODELSCOPE_CACHE: join(this.runtime, 'modelscope-cache'), WESPEAKER_HOME: join(this.runtime, 'wespeaker-models'),
          HF_HOME: join(this.runtime, 'huggingface-cache'), TMP: join(this.runtime, 'temp'), TEMP: join(this.runtime, 'temp'),
          UTMOSV2_CHECKPOINT: join(this.runtime, 'utmosv2', 'fold0_s42_best_model.pth'),
          PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
          HF_HUB_OFFLINE: '1',
          OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', TOKENIZERS_PARALLELISM: 'false',
        },
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject); child.once('exit', (code) => {
        if (code !== 0) { reject(new Error(`${tool} worker 退出码 ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`)); return; }
        const marker = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('CARROT_SPEECH_EVALUATOR_RESULT='));
        if (!marker) { reject(new Error(`${tool} worker 未返回结构化结果: ${stderr.slice(-2000) || stdout.slice(-2000)}`)); return; }
        try { resolvePromise((JSON.parse(marker.slice('CARROT_SPEECH_EVALUATOR_RESULT='.length)).items ?? []) as Record<string, unknown>[]); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ items }));
    });
  }
}
