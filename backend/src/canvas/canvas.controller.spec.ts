import { Test } from '@nestjs/testing';
import { INestApplication, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { CanvasController } from './canvas.controller';
import { CanvasService } from './canvas.service';
import { emptyCanvasGraph } from './canvas.entity';

describe('CanvasController (e2e)', () => {
  let app: INestApplication;
  const service = {
    list: jest.fn(),
    create: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CanvasController],
      providers: [{ provide: CanvasService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/canvas → 200 列表（不回 graph）', async () => {
    service.list.mockResolvedValue([
      { id: 'c1', name: 'a', createdAt: new Date(), updatedAt: new Date(), nodeCount: 0, assetSize: 0 },
    ]);
    const res = await request(app.getHttpServer()).get('/api/canvas').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('c1');
    expect(res.body[0].graph).toBeUndefined();
  });

  it('POST /api/canvas → 201 新建画布', async () => {
    service.create.mockResolvedValue({ id: 'c1', name: '新画布', graph: emptyCanvasGraph() });
    const res = await request(app.getHttpServer())
      .post('/api/canvas')
      .send({ name: '新画布' })
      .expect(201);
    expect(res.body.name).toBe('新画布');
    expect(service.create).toHaveBeenCalledWith({ name: '新画布' });
  });

  it('GET /api/canvas/:id → 200 完整画布', async () => {
    service.findOne.mockResolvedValue({ id: 'c1', name: 'a', graph: emptyCanvasGraph() });
    const res = await request(app.getHttpServer()).get('/api/canvas/c1').expect(200);
    expect(res.body.graph.nodes).toEqual([]);
  });

  it('GET /api/canvas/:id 不存在 → 404', async () => {
    service.findOne.mockRejectedValue(new NotFoundException('不存在'));
    await request(app.getHttpServer()).get('/api/canvas/nope').expect(404);
  });

  it('PATCH /api/canvas/:id → 200 保存', async () => {
    service.update.mockResolvedValue({ id: 'c1', name: 'b', graph: emptyCanvasGraph() });
    const res = await request(app.getHttpServer())
      .patch('/api/canvas/c1')
      .send({ name: 'b', graph: emptyCanvasGraph() })
      .expect(200);
    expect(res.body.name).toBe('b');
    expect(service.update).toHaveBeenCalledWith('c1', { name: 'b', graph: emptyCanvasGraph() });
  });

  it('DELETE /api/canvas/:id → 204', async () => {
    service.remove.mockResolvedValue(undefined);
    await request(app.getHttpServer()).delete('/api/canvas/c1').expect(204);
    expect(service.remove).toHaveBeenCalledWith('c1');
  });
});
