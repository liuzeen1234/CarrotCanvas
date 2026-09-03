import { BadRequestException, Controller, Delete, Get, Headers, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { basename } from 'path';
import { stat } from 'fs/promises';
import { AssetsService } from './assets.service';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** 删除画布节点的全部生成资产（删除生成节点时调用） */
  @Delete('generated/by-node')
  async deleteGeneratedByNode(@Query('canvasId') canvasId: string, @Query('nodeId') nodeId: string) {
    if (!canvasId || !nodeId) throw new BadRequestException('缺少 canvasId 或 nodeId');
    await this.assets.deleteGeneratedByNode(canvasId, nodeId);
    return { ok: true };
  }

  /** 读取资产（内联展示）：按 id 定位文件并流式返回，Content-Type 按 mime */
  @Get(':id')
  async get(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: any,
  ): Promise<StreamableFile> {
    const { asset, absPath } = await this.assets.read(id);
    const size = (await stat(absPath)).size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', contentDisposition('inline', basename(absPath)));

    const parsed = parseByteRange(range, size);
    if (parsed) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${size}`);
      res.setHeader('Content-Length', parsed.end - parsed.start + 1);
      return new StreamableFile(
        this.assets.createReadStream(absPath, { start: parsed.start, end: parsed.end }),
        { type: asset.mime ?? 'application/octet-stream' },
      );
    }

    res.setHeader('Content-Length', size);
    return new StreamableFile(this.assets.createReadStream(absPath), {
      type: asset.mime ?? 'application/octet-stream',
    });
  }

  /** 下载资产：Content-Disposition: attachment */
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: any,
  ): Promise<StreamableFile> {
    const { asset, absPath } = await this.assets.read(id);
    const filename = asset.originName || basename(absPath);
    res.setHeader(
      'Content-Disposition',
      contentDisposition('attachment', filename),
    );
    return new StreamableFile(this.assets.createReadStream(absPath), {
      type: asset.mime ?? 'application/octet-stream',
    });
  }
}

/** 解析浏览器媒体播放器发送的单段 bytes Range；非法/多段请求回退为完整响应。 */
export function parseByteRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * HTTP 响应头只能安全携带 ASCII。filename 提供兼容回退名，filename* 按 RFC 5987
 * 保留中文等 Unicode 原名；避免 Node 因中文输出名抛 ERR_INVALID_CHAR。
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'asset';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
