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

describe('AssetsController (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let filePath: string;
  const service = {
    read: jest.fn(),
    createReadStream: jest.fn(),
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-assets-ctrl-'));
    filePath = join(dir, 'x.png');
    writeFileSync(filePath, Buffer.from('fake-png-bytes'));
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetsController],
      providers: [{ provide: AssetsService, useValue: service }],
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
  });

  it('GET /api/assets/:id 资产不存在 → 404', async () => {
    service.read.mockRejectedValue(new NotFoundException('资产不存在'));
    await request(app.getHttpServer()).get('/api/assets/nope').expect(404);
  });
});
