import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

export interface ComfyUIWorkflowFile {
  /** 相对 workflows 目录的文件名，如 xxx.json */
  filename: string;
  /** 服务端返回的路径字段 */
  path?: string;
  size?: number;
  modified?: number;
  created?: number;
}

export interface ComfyUISubmitResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

/**
 * ComfyUI HTTP 客户端：统一封装对 ComfyUI 服务（8188）的调用。
 * 地址来自 settings 表 comfyui-url，默认 http://localhost:8188。
 */
@Injectable()
export class ComfyUIClientService {
  private objectInfoCache: Record<string, unknown> | null = null;

  constructor(private readonly settings: SettingsService) {}

  private async getBaseUrl(): Promise<string> {
    const row = await this.settings.get('comfyui-url');
    const url = (row?.value ?? 'http://localhost:8188').trim().replace(/\/+$/, '');
    return url || 'http://localhost:8188';
  }

  /** 公开：获取 ComfyUI 服务地址（不含末尾斜杠） */
  async getServerUrl(): Promise<string> {
    return this.getBaseUrl();
  }

  /** 公开：获取 ComfyUI WebSocket 地址 */
  async getWsUrl(clientId: string): Promise<string> {
    const base = await this.getBaseUrl();
    return `${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const base = await this.getBaseUrl();
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, init);
    } catch (e) {
      throw new HttpException(
        `无法连接 ComfyUI（${base}）：${(e as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!resp.ok) {
      throw new HttpException(
        `ComfyUI 请求失败 ${path}：HTTP ${resp.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return resp;
  }

  /** 列出 ComfyUI 已保存的工作流文件 */
  async listWorkflows(): Promise<ComfyUIWorkflowFile[]> {
    const resp = await this.request('/userdata?dir=workflows&recurse=true&full_info=true');
    const data = (await resp.json()) as unknown;
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as { value?: unknown })?.value)
        ? ((data as { value: unknown[] }).value)
        : [];
    return arr.map((v) => {
      if (typeof v === 'string') return { filename: v, path: v };
      const obj = v as { path?: string; name?: string; size?: number; modified?: number; created?: number };
      return {
        filename: obj.path ?? obj.name ?? String(v),
        path: obj.path ?? obj.name,
        size: obj.size,
        modified: obj.modified,
        created: obj.created,
      };
    });
  }

  /** 读取工作流文件内容（UI 格式 JSON） */
  async getWorkflowJson(filename: string): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(`workflows/${filename}`);
    const resp = await this.request(`/userdata/${encoded}`);
    const text = await resp.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HttpException(`工作流 ${filename} 不是有效 JSON`, HttpStatus.BAD_REQUEST);
    }
  }

  /** 获取全部节点定义（带缓存，force 可刷新） */
  async getObjectInfo(force = false): Promise<Record<string, unknown>> {
    if (this.objectInfoCache && !force) return this.objectInfoCache;
    const resp = await this.request('/object_info');
    const data = (await resp.json()) as Record<string, unknown>;
    this.objectInfoCache = data;
    return data;
  }

  /** 提交 prompt 到 /prompt */
  async submitPrompt(
    prompt: Record<string, unknown>,
    clientId?: string,
  ): Promise<ComfyUISubmitResult> {
    const body: Record<string, unknown> = { prompt };
    if (clientId) body.client_id = clientId;
    const resp = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text };
    }
    if (data.error) {
      throw new HttpException(`ComfyUI 拒绝提交：${String(data.error)}`, HttpStatus.BAD_REQUEST);
    }
    return {
      prompt_id: String(data.prompt_id),
      number: Number(data.number),
      node_errors: (data.node_errors as Record<string, unknown>) ?? {},
    };
  }

  /** 查询运行历史（输出结果） */
  async getHistory(promptId: string): Promise<Record<string, unknown>> {
    const resp = await this.request(`/history/${promptId}`);
    return (await resp.json()) as Record<string, unknown>;
  }

  /** 构造图片访问 URL（/view） */
  async buildViewUrl(params: {
    filename: string;
    type?: string;
    subfolder?: string;
  }): Promise<string> {
    const base = await this.getBaseUrl();
    const qs = new URLSearchParams({ filename: params.filename });
    if (params.type) qs.set('type', params.type);
    if (params.subfolder) qs.set('subfolder', params.subfolder);
    return `${base}/view?${qs.toString()}`;
  }

  async getSystemStats(): Promise<Record<string, unknown>> {
    const resp = await this.request('/system_stats');
    return (await resp.json()) as Record<string, unknown>;
  }

  /** 中断当前运行 */
  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' });
  }
}
