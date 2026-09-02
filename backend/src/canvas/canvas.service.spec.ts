import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CanvasService } from './canvas.service';
import { CanvasDoc, emptyCanvasGraph } from './canvas.entity';

describe('CanvasService', () => {
  let service: CanvasService;
  let repo: any;
  let assets: any;

  const baseDoc = (over: Partial<CanvasDoc> = {}): CanvasDoc =>
    ({
      id: 'c1',
      name: '画布',
      graph: emptyCanvasGraph(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    } as CanvasDoc);

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x: any) => ({ id: 'uuid-1', ...x })),
      save: jest.fn(async (x: any) => x),
      remove: jest.fn(),
    };
    assets = {
      ensureCanvasPartition: jest.fn(async () => undefined),
      deleteCanvas: jest.fn(async () => undefined),
      getCanvasAssetSizes: jest.fn(async () => ({})),
    };
    service = new CanvasService(repo as any, assets as any);
  });

  describe('create', () => {
    it('缺省名 + 空图，并创建资产分区', async () => {
      const created = await service.create({});
      expect(created.name).toBe('未命名画布');
      expect(created.graph).toEqual(emptyCanvasGraph());
      expect(assets.ensureCanvasPartition).toHaveBeenCalledWith('uuid-1');
    });

    it('name 去除首尾空格', async () => {
      const created = await service.create({ name: '  我的画布 ' });
      expect(created.name).toBe('我的画布');
    });
  });

  describe('list', () => {
    it('返回节点数与资产大小（按画布聚合）', async () => {
      repo.find.mockResolvedValue([
        baseDoc({ id: 'c1', graph: { ...emptyCanvasGraph(), nodes: [{}, {}] } }),
        baseDoc({ id: 'c2' }),
      ]);
      assets.getCanvasAssetSizes.mockResolvedValue({ c1: 100, c2: 50 });
      const list = await service.list();
      expect(list).toHaveLength(2);
      expect(list[0].nodeCount).toBe(2);
      expect(list[0].assetSize).toBe(100);
      expect(list[1].nodeCount).toBe(0);
      expect(list[1].assetSize).toBe(50);
    });
  });

  describe('findOne', () => {
    it('存在返回完整画布', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await expect(service.findOne('c1')).resolves.toEqual(d);
    });

    it('不存在抛 NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('改名并保存 graph', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      const graph = {
        version: 1,
        nodes: [{ id: 'n1' }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      await service.update('c1', { name: ' 新名字 ', graph });
      expect(d.name).toBe('新名字');
      expect(d.graph).toBe(graph);
      expect(repo.save).toHaveBeenCalledWith(d);
    });

    it('空名抛 BadRequest', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await expect(service.update('c1', { name: '   ' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('非法 graph 抛 BadRequest', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await expect(
        service.update('c1', {
          graph: { version: 'x', nodes: [], edges: [] },
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('级联删除资产并删画布', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await service.remove('c1');
      expect(assets.deleteCanvas).toHaveBeenCalledWith('c1');
      expect(repo.remove).toHaveBeenCalledWith(d);
    });

    it('不存在抛 NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
