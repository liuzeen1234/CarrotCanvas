import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NotFoundException } from '@nestjs/common';
import { createReadStream } from 'fs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { CanvasService } from '../canvas/canvas.service';

describe('AssetsController (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let filePath: string;
  let unicodeFilePath: string;
  const service = {
    read: jest.fn(),
    createReadStream: jest.fn(),
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-assets-ctrl-'));
    filePath = join(dir, 'x.png');
    unicodeFilePath = join(dir, '三视图.png');
    writeFileSync(filePath, Buffer.from('fake-png-bytes'));
    writeFileSync(unicodeFilePath, Buffer.from('unicode-png'));
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetsController],
      providers: [{ provide: AssetsService, useValue: service }, { provide: CanvasService, useValue: { assertWriteAccess: jest.fn() } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.createReadStream.mockReturnValue(createReadStream(filePath));
  });

  it('GET /api/assets/:id → 200 内联读取，mime 正确、字节一致', async () => {
    service.read.mockResolvedValue({
      asset: { id: 'a1', mime: 'image/png' },
      absPath: filePath,
    });
    const res = await request(app.getHttpServer()).get('/api/assets/a1').expect(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.body).toEqual(Buffer.from('fake-png-bytes'));
  });

  it('GET /api/assets/:id/download → 200 附件下载头', async () => {
    service.read.mockResolvedValue({
      asset: { id: 'a1', mime: 'image/png', originName: 'hello.png' },
      absPath: filePath,
    });
    const res = await request(app.getHttpServer())
      .get('/api/assets/a1/download')
      .expect(200);
    const disposition = String(res.headers['content-disposition'] || '');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('hello.png');
    expect(res.headers['content-length']).toBe('14');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, no-transform');
    expect(res.body).toEqual(Buffer.from('fake-png-bytes'));
  });

  it('视频 Range 请求 → 206 分段响应，供浏览器播放器 seek/解码', async () => {
    service.read.mockResolvedValue({
      asset: { id: 'v1', mime: 'video/mp4' },
      absPath: filePath,
    });
    service.createReadStream.mockImplementationOnce((path: string, options: any) => createReadStream(path, options));
    const res = await request(app.getHttpServer())
      .get('/api/assets/v1')
      .set('Range', 'bytes=2-5')
      .expect(206);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBe('bytes 2-5/14');
    expect(res.headers['content-length']).toBe('4');
    expect(res.body).toEqual(Buffer.from('ke-p'));
  });

  it('中文文件名可内联展示，响应头使用 ASCII 回退 + UTF-8 filename*', async () => {
    service.read.mockResolvedValue({
      asset: { id: 'cn', mime: 'image/png' },
      absPath: unicodeFilePath,
    });
    service.createReadStream.mockReturnValueOnce(createReadStream(unicodeFilePath));
    const res = await request(app.getHttpServer()).get('/api/assets/cn').expect(200);
    const disposition = String(res.headers['content-disposition'] || '');
    expect(disposition).toContain('inline');
    expect(disposition).toContain("filename*=UTF-8''%E4%B8%89%E8%A7%86%E5%9B%BE.png");
    expect(res.body).toEqual(Buffer.from('unicode-png'));
  });

  it('中文原名可作为附件下载且不会触发非法响应头', async () => {
    service.read.mockResolvedValue({
      asset: { id: 'cn', mime: 'image/png', originName: 'Z-Image-文生图.png' },
      absPath: filePath,
    });
    const res = await request(app.getHttpServer()).get('/api/assets/cn/download').expect(200);
    expect(String(res.headers['content-disposition'] || '')).toContain(
      "filename*=UTF-8''Z-Image-%E6%96%87%E7%94%9F%E5%9B%BE.png",
    );
  });

  it('GET /api/assets/:id 资产不存在 → 404', async () => {
    service.read.mockRejectedValue(new NotFoundException('资产不存在'));
    await request(app.getHttpServer()).get('/api/assets/nope').expect(404);
  });
});
