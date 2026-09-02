import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { basename } from 'path';
import { AssetsService } from './assets.service';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** 读取资产（内联展示）：按 id 定位文件并流式返回，Content-Type 按 mime */
  @Get(':id')
  async get(@Param('id') id: string): Promise<StreamableFile> {
    const { asset, absPath } = await this.assets.read(id);
    return new StreamableFile(this.assets.createReadStream(absPath), {
      type: asset.mime ?? 'application/octet-stream',
      disposition: `inline; filename="${basename(absPath)}"`,
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
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    return new StreamableFile(this.assets.createReadStream(absPath), {
      type: asset.mime ?? 'application/octet-stream',
    });
  }
}
