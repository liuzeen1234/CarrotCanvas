import {
  Injectable,
  OnModuleDestroy,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ComfyUIClientService } from './comfyui-client';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'unknown';

export interface RunNodeProgress {
  value: number;
  max: number;
  state: string;
}

export interface RunOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  /** 后端代理访问路径（相对，如 /api/comfyui/view?...) */
  url: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  /** 平台资产 id（画布节点运行时，捕获成功后回填） */
  assetId?: string | null;
  /** 平台资产访问路径（相对，如 /api/assets/:id） */
  assetUrl?: string | null;
}

export interface RunState {
  promptId: string;
  workflowId?: string;
  title: string;
  status: RunStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  currentNode?: string | null;
  currentNodeTitle?: string;
  progress?: { value: number; max: number };
  nodes: Record<string, RunNodeProgress>;
  /** nodeId → 节点显示名（来自提交的 apiJson _meta） */
  nodeTitles: Record<string, string>;
  outputs: RunOutputFile[];
  error?: string;
  nodeErrors: Record<string, unknown>;
  /** 画布上下文（画布生成节点发起时带，用于产物捕获） */
  canvasId?: string;
  nodeId?: string | null;
}

interface WsMessage {
  type: string;
  data?: Record<string, any>;
}

const MAX_RUNS = 50;

/**
 * ComfyUI 运行执行服务：
 * 1) POST /prompt 提交；2) 通过 WebSocket /ws 实时监控进度；
 * 3) 收集节点输出；4) 维护运行状态（内存），供查询与前端轮询。
 */
@Injectable()
export class ComfyUIRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger('ComfyUIRunner');
  private readonly runs = new Map<string, RunState>();
  private readonly onComplete = new Map<string, (run: RunState) => void>();

  private ws: WebSocket | null = null;
  private readonly clientId = randomUUID();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  /** 进行中的 WS 连接 Promise（供并发提交复用同一个连接） */
  private connectingPromise: Promise<void> | null = null;

  constructor(private readonly client: ComfyUIClientService) {}

  getRun(promptId: string): RunState | undefined {
    return this.runs.get(promptId);
  }

  listRuns(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.queuedAt - a.queuedAt);
  }

  /** 提交 prompt 到 ComfyUI 并开始监控 */
  async submit(
    apiJson: Record<string, unknown>,
    options: {
      title?: string;
      workflowId?: string;
      canvasId?: string;
      nodeId?: string | null;
      onComplete?: (run: RunState) => void;
    } = {},
  ): Promise<RunState> {
    // 先确保 WS 连接就绪再提交：ComfyUI 仅在提交时该 client 的 WS 已连接时下发 execution 消息，
    // 先提交后连接会导致 run 永远收不到状态更新（卡 pending）。
    await this.ensureWs();
    let result;
    try {
      result = await this.client.submitPrompt(expandFrontendWildcards(apiJson), this.clientId);
    } catch (e) {
      const err = e as HttpException;
      const status = err?.getStatus?.() ?? HttpStatus.BAD_GATEWAY;
      if (status === HttpStatus.BAD_REQUEST && err?.getResponse?.()) {
        throw err;
      }
      throw err;
    }

    const now = Date.now();
    const nodeTitles: Record<string, string> = {};
    for (const [nodeId, node] of Object.entries(apiJson)) {
      const meta = (node as { _meta?: { title?: string } })?._meta;
      nodeTitles[nodeId] = meta?.title ?? nodeId;
    }
    const run: RunState = {
      promptId: result.prompt_id,
      workflowId: options.workflowId,
      title: options.title ?? 'ComfyUI 运行',
      status: 'pending',
      queuedAt: now,
      nodes: {},
      nodeTitles,
      outputs: [],
      nodeErrors: result.node_errors ?? {},
      canvasId: options.canvasId,
      nodeId: options.nodeId ?? null,
    };

    // 节点级校验错误：直接判定失败
    const nodeErrors = result.node_errors ?? {};
    const errorKeys = Object.keys(nodeErrors);
    if (errorKeys.length) {
      run.status = 'error';
      run.finishedAt = now;
      run.error = `ComfyUI 校验失败：${errorKeys.join('、')}`;
      this.runs.set(run.promptId, run);
      if (options.onComplete) options.onComplete(run);
      return run;
    }

    this.runs.set(run.promptId, run);
    if (options.onComplete) this.onComplete.set(run.promptId, options.onComplete);
    this.prune();
    return run;
  }

  /** 中断指定运行 */
  async interrupt(): Promise<void> {
    await this.client.interrupt();
  }

  private prune() {
    if (this.runs.size <= MAX_RUNS) return;
    const sorted = [...this.runs.entries()].sort((a, b) => b[1].queuedAt - a[1].queuedAt);
    for (const [id] of sorted.slice(MAX_RUNS)) {
      this.runs.delete(id);
      this.onComplete.delete(id);
    }
  }

  // ---------- WebSocket 监控 ----------

  /** 确保 WebSocket 已连接；返回的 Promise 在连接就绪（open 或失败）后 resolve */
  private ensureWs(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting && this.connectingPromise) return this.connectingPromise;
    this.connecting = true;
    this.connectingPromise = this.connectWs().finally(() => {
      this.connecting = false;
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  /** 建立 WS 连接，onopen 或 onerror 时 resolve（供 submit 在提交前等待连接就绪） */
  private connectWs(): Promise<void> {
    return new Promise<void>((resolve) => {
      void (async () => {
        try {
          const wsUrl = await this.client.getWsUrl(this.clientId);
          const ws = new WebSocket(wsUrl);
          this.ws = ws;
          ws.onopen = () => {
            this.logger.log('ComfyUI WebSocket 已连接');
            resolve();
          };
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(String(ev.data)) as WsMessage;
              this.handleMessage(msg);
            } catch (e) {
              this.logger.warn(`WS 消息解析失败：${(e as Error).message}`);
            }
          };
          ws.onerror = () => {
            this.logger.warn('ComfyUI WebSocket 错误');
            resolve();
          };
          ws.onclose = () => {
            this.logger.warn('ComfyUI WebSocket 已断开');
            this.ws = null;
            this.scheduleReconnect();
          };
        } catch (e) {
          this.logger.error(`连接 ComfyUI WebSocket 失败：${(e as Error).message}`);
          this.ws = null;
          this.scheduleReconnect();
          resolve();
        }
      })();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureWs();
    }, 5000);
  }

  private handleMessage(msg: WsMessage) {
    const data = msg.data ?? {};
    const promptId = data.prompt_id as string | undefined;
    if (!promptId || !this.runs.has(promptId)) return;

    const run = this.runs.get(promptId)!;
    switch (msg.type) {
      case 'execution_start': {
        run.status = 'running';
        run.startedAt = Date.now();
        break;
      }
      case 'execution_cached': {
        run.status = run.status === 'pending' ? 'running' : run.status;
        break;
      }
      case 'progress': {
        // 旧版进度消息 { value, max }
        const value = Number(data.value);
        const max = Number(data.max);
        if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
          run.progress = { value, max };
        }
        break;
      }
      case 'progress_state': {
        // 新版进度消息 { nodes: { nodeId: {value,max,state} } }
        const nodes = data.nodes;
        if (nodes && typeof nodes === 'object') {
          for (const [nodeId, p] of Object.entries(nodes as Record<string, any>)) {
            run.nodes[nodeId] = {
              value: Number(p?.value ?? 0),
              max: Number(p?.max ?? 0),
              state: String(p?.state ?? ''),
            };
          }
          this.recomputeProgress(run);
        }
        break;
      }
      case 'executing': {
        const node = data.node ?? null;
        run.currentNode = node === null ? null : String(node);
        run.currentNodeTitle =
          node === null ? undefined : (run.nodeTitles[String(node)] ?? String(node));
        if (node !== null && run.status === 'pending') run.status = 'running';
        break;
      }
      case 'executed': {
        this.collectOutputs(run, data.output);
        break;
      }
      case 'execution_success': {
        run.status = 'success';
        run.finishedAt = Date.now();
        run.currentNode = null;
        this.finish(run);
        break;
      }
      case 'execution_error': {
        run.status = 'error';
        run.finishedAt = Date.now();
        run.error = data.exception_message
          ? `节点 ${data.node_type ?? ''}（${data.node_id ?? ''}）：${data.exception_message}`
          : '执行出错';
        this.finish(run);
        break;
      }
      case 'execution_interrupted': {
        run.status = 'interrupted';
        run.finishedAt = Date.now();
        this.finish(run);
        break;
      }
      default:
        break;
    }
  }

  /** 汇总节点进度（各节点进度加权平均） */
  private recomputeProgress(run: RunState) {
    let sumV = 0;
    let sumM = 0;
    for (const p of Object.values(run.nodes)) {
      if (p.max > 0) {
        sumV += Math.min(p.value, p.max);
        sumM += p.max;
      }
    }
    if (sumM > 0) run.progress = { value: sumV, max: sumM };
  }

  /** 从 executed 输出收集图片/视频文件 */
  private collectOutputs(run: RunState, output: any) {
    if (!output || typeof output !== 'object') return;
    const seen = new Set(run.outputs.map((o) => `${o.type}/${o.subfolder}/${o.filename}`));
    const pushFiles = (arr: unknown, kind: RunOutputFile['kind']) => {
      if (!Array.isArray(arr)) return;
      for (const f of arr) {
        if (!f || typeof f !== 'object') continue;
        const rec = f as { filename?: string; subfolder?: string; type?: string };
        if (!rec.filename) continue;
        const subfolder = rec.subfolder ?? '';
        const type = rec.type ?? 'output';
        const key = `${type}/${subfolder}/${rec.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        run.outputs.push({
          filename: rec.filename,
          subfolder,
          type,
          kind,
          url: `/api/comfyui/view?filename=${encodeURIComponent(rec.filename)}&type=${encodeURIComponent(type)}${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ''}`,
        });
      }
    };
    pushFiles(output.images, 'image');
    pushFiles(output.gifs, 'image');
    pushFiles(output.videos, 'video');
    pushFiles(output.audio, 'audio');
  }

  /** 完成时回调（供 controller 写回 thumbnail 等） */
  private finish(run: RunState) {
    const cb = this.onComplete.get(run.promptId);
    if (cb) {
      this.onComplete.delete(run.promptId);
      try {
        cb(run);
      } catch (e) {
        this.logger.error(`onComplete 回调失败：${(e as Error).message}`);
      }
    }
  }

  /** 节点标题映射：从 submitted prompt 的 _meta 构建（由 controller 注入） */
  private nodeTitleMap = new Map<string, string>();

  setNodeTitleMap(promptId: string, map: Map<string, string>) {
    this.nodeTitleMap = map;
  }

  private nodeTitle(run: RunState, nodeId: unknown): string | undefined {
    return this.nodeTitleMap.get(String(nodeId));
  }

  onModuleDestroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 简单日期格式化，支持 yyyy/MM/dd/HH/mm/ss 等常用 token */
function formatDate(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    yy: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return fmt.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (m) => map[m] ?? m);
}

/**
 * 展开 ComfyUI 官方前端在提交前处理的 %date:...% / %time:...% 动态通配符
 * （保存文件名的日期/时间占位，官方前端客户端展开后再 POST /prompt）。
 * 深拷贝避免污染入库模板。
 */
function expandFrontendWildcards(apiJson: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(apiJson)) {
    const n = node as Record<string, unknown>;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      inputs[k] = expandValue(v);
    }
    out[nodeId] = { ...n, inputs };
  }
  return out;

  function expandValue(v: unknown): unknown {
    if (typeof v === 'string') {
      return v.replace(/%date:([^%]+)%|%time:([^%]+)%/g, (m, dateFmt, timeFmt) => {
        const now = new Date();
        if (dateFmt) return formatDate(now, dateFmt);
        if (timeFmt) return formatDate(now, timeFmt);
        return m;
      });
    }
    if (Array.isArray(v)) return v.map(expandValue);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = expandValue(val);
      return o;
    }
    return v;
  }
}
