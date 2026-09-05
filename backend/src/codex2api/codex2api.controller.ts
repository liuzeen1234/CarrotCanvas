import {
  Body, Controller, Get, Post, Put, Query, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Codex2ApiService, UploadFile } from './codex2api.service';
import { CanvasService } from '../canvas/canvas.service';

@Controller('codex2api')
export class Codex2ApiController {
  constructor(private readonly service: Codex2ApiService, private readonly canvas: CanvasService) {}

  @Get('config')
  getConfig() { return this.service.getPublicConfig(); }

  @Put('config')
  updateConfig(@Body() body: { baseUrl?: string; apiKey?: string | null; clearApiKey?: boolean }) {
    return this.service.updateConfig(body || {});
  }

  @Get('health')
  async health() {
    const response = await this.service.request('/health', {}, 10_000);
    return this.service.readJsonResponse(response);
  }

  @Get('models')
  async models() {
    const response = await this.service.request('/v1/models', {}, 15_000);
    return this.service.readJsonResponse(response);
  }

  @Get('image')
  async image(@Query('url') url: string, @Query('download') download: string | undefined, @Res() res: any) {
    const upstream = await this.service.fetchImage(url);
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', download === '1' ? 'attachment; filename="codex2api-image.png"' : 'inline');
    const reader = upstream.body?.getReader();
    if (!reader) return res.end();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally { res.end(); }
  }

  @Post('chat/completions')
  async chat(@Body() body: any, @Res() res: any) {
    const upstream = await this.service.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, body?.stream ? 300_000 : 120_000);
    if (!upstream.ok) {
      const payload = await this.service.readJsonResponse(upstream);
      return res.status(upstream.status).json(payload);
    }
    if (body?.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      const reader = upstream.body?.getReader();
      if (!reader) return res.end();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        res.end();
      }
      return;
    }
    const payload = await this.service.readJsonResponse(upstream);
    return res.status(200).json(payload);
  }

  @Post('images/generations')
  async generate(@Body() body: any) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, ...upstreamBody } = body || {};
    if (canvasId) await this.canvas.assertWriteAccess(canvasId, { leaseToken, leaseEpoch, expectedRevision });
    const payload = await this.service.forwardJson('/v1/images/generations', upstreamBody, 600_000);
    return this.service.captureImages(payload, canvasId, nodeId);
  }

  @Post('images/edits')
  @UseInterceptors(FilesInterceptor('image', 10, { limits: { fileSize: 15 * 1024 * 1024 } }))
  async edit(@UploadedFiles() files: UploadFile[], @Body() body: Record<string, unknown>) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, ...fields } = body || {};
    if (canvasId) await this.canvas.assertWriteAccess(String(canvasId), { leaseToken: String(leaseToken || ''), leaseEpoch: Number(leaseEpoch), expectedRevision: Number(expectedRevision) });
    const payload = await this.service.forwardMultipart('/v1/images/edits', files || [], fields);
    return this.service.captureImages(payload, String(canvasId || ''), String(nodeId || ''));
  }

  @Post('images/analyze')
  @UseInterceptors(FilesInterceptor('image', 10, { limits: { fileSize: 15 * 1024 * 1024 } }))
  analyze(@UploadedFiles() files: UploadFile[], @Body() body: Record<string, unknown>) {
    return this.service.forwardMultipart('/v1/images/analyze', files || [], body || {});
  }
}
