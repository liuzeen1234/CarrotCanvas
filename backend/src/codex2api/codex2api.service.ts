import { BadGatewayException, BadRequestException, Injectable, RequestTimeoutException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { AssetsService } from '../assets/assets.service';

const DEFAULT_BASE_URL = 'http://localhost:3010';
const BASE_URL_KEY = 'codex2api-base-url';
const API_KEY_KEY = 'codex2api-api-key';

export interface UploadFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

@Injectable()
export class Codex2ApiService {
  constructor(
    private readonly settings: SettingsService,
    private readonly assets: AssetsService,
  ) {}

  async getPublicConfig() {
    const [baseUrl, apiKey] = await Promise.all([
      this.settings.get(BASE_URL_KEY),
      this.settings.get(API_KEY_KEY),
    ]);
    return {
      baseUrl: baseUrl?.value || DEFAULT_BASE_URL,
      hasApiKey: !!apiKey?.value,
      defaultModel: 'codex',
    };
  }

  async updateConfig(input: { baseUrl?: string; apiKey?: string | null; clearApiKey?: boolean }) {
    if (input.baseUrl !== undefined) {
      const normalized = this.normalizeBaseUrl(input.baseUrl);
      await this.settings.set(BASE_URL_KEY, normalized);
    }
    if (input.clearApiKey) await this.settings.set(API_KEY_KEY, null);
    else if (input.apiKey !== undefined && input.apiKey !== null && input.apiKey.trim()) {
      await this.settings.set(API_KEY_KEY, input.apiKey.trim());
    }
    return this.getPublicConfig();
  }

  async request(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
    const [baseUrlRow, apiKeyRow] = await Promise.all([
      this.settings.get(BASE_URL_KEY),
      this.settings.get(API_KEY_KEY),
    ]);
    const baseUrl = this.normalizeBaseUrl(baseUrlRow?.value || DEFAULT_BASE_URL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    if (apiKeyRow?.value) headers.set('Authorization', `Bearer ${apiKeyRow.value}`);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new RequestTimeoutException('Codex2API 请求超时');
      throw new BadGatewayException('无法连接 Codex2API，请检查服务地址和运行状态');
    } finally {
      clearTimeout(timer);
    }
  }

  async forwardJson(path: string, body: unknown, timeoutMs?: number) {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
    return this.readJsonResponse(response);
  }

  async forwardMultipart(path: string, files: UploadFile[], fields: Record<string, unknown>, timeoutMs = 300_000) {
    if (!files.length) throw new BadRequestException('请选择要上传的图片');
    const form = new FormData();
    for (const file of files) {
      form.append('image', new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }), file.originalname);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
    }
    // 不设置 Content-Type；fetch 会为 FormData 自动生成带 boundary 的请求头。
    const response = await this.request(path, { method: 'POST', body: form }, timeoutMs);
    return this.readJsonResponse(response);
  }

  async captureImages(
    payload: any,
    canvasId?: string,
    nodeId?: string,
  ) {
    if (!Array.isArray(payload?.data)) return payload;
    if (!canvasId || !nodeId) {
      // Codex2API 通常返回 localhost:3010/files/...。浏览器从手机访问时，
      // localhost 会指向手机自身，因此统一改写为 CarrotCanvas 同源代理地址。
      return {
        ...payload,
        data: payload.data.map((item: any) => item?.url ? {
          ...item,
          url: `/api/codex2api/image?url=${encodeURIComponent(item.url)}`,
          downloadUrl: `/api/codex2api/image?download=1&url=${encodeURIComponent(item.url)}`,
        } : item),
      };
    }
    const captured = [];
    for (let index = 0; index < payload.data.length; index += 1) {
      const item = payload.data[index] || {};
      let buffer: Buffer;
      let mime = 'image/png';
      if (item.b64_json) {
        buffer = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const response = await fetch(item.url);
        if (!response.ok) throw new BadGatewayException(`生成图片下载失败：HTTP ${response.status}`);
        mime = response.headers.get('content-type')?.split(';')[0] || mime;
        buffer = Buffer.from(await response.arrayBuffer());
      } else continue;
      const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
      const asset = await this.assets.saveGenerated({
        canvasId,
        nodeId,
        kind: 'image',
        buffer,
        originName: `codex2api-${Date.now()}-${index + 1}.${ext}`,
        mime,
      });
      captured.push({
        revised_prompt: item.revised_prompt,
        assetId: asset.id,
        url: `/api/assets/${asset.id}`,
        downloadUrl: `/api/assets/${asset.id}/download`,
      });
    }
    return { ...payload, data: captured.length ? captured : payload.data };
  }

  async readJsonResponse(response: Response) {
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: { message: text || `HTTP ${response.status}` } }; }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `Codex2API 请求失败：HTTP ${response.status}`;
      throw new BadGatewayException(message);
    }
    if (payload?.error) throw new BadGatewayException(payload.error.message || 'Codex2API 返回错误');
    return payload;
  }

  async fetchImage(rawUrl: string): Promise<Response> {
    if (!rawUrl) throw new BadRequestException('缺少图片地址');
    const configured = await this.getPublicConfig();
    let target: URL;
    let allowed: URL;
    try {
      target = new URL(rawUrl);
      allowed = new URL(configured.baseUrl);
    } catch {
      throw new BadRequestException('图片地址格式不正确');
    }
    if (target.origin !== allowed.origin) throw new BadRequestException('不允许代理其他服务的图片');
    const path = `${target.pathname}${target.search}`;
    const response = await this.request(path, {}, 120_000);
    if (!response.ok) await this.readJsonResponse(response);
    return response;
  }

  private normalizeBaseUrl(value: string) {
    const text = value.trim().replace(/\/+$/, '');
    let url: URL;
    try { url = new URL(text); }
    catch { throw new BadRequestException('服务地址格式不正确'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('服务地址仅支持 HTTP 或 HTTPS');
    return text;
  }
}
