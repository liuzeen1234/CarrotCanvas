import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CanvasService } from './canvas.service';
import { CanvasAssetGcJob, CanvasDoc, CanvasGraph, CanvasOperationLog, emptyCanvasGraph } from './canvas.entity';
import { Workflow } from '../workflows/workflow.entity';

describe('CanvasService', () => {
  let service: CanvasService;
  let repo: any;
  let assets: any;
  let leases: any;
  let receipts: any;

  const baseDoc = (over: Partial<CanvasDoc> = {}): CanvasDoc =>
    ({
      id: 'c1',
      name: '画布',
      graph: emptyCanvasGraph(),
      createdAt: new Date(),
      updatedAt: new Date(),
      revision: 0,
      schemaVersion: 1,
      brief: null,
      activeCheckpointId: null,
      lastHandoffId: null,
      updatedByType: null,
      updatedById: null,
      ...over,
    } as CanvasDoc);

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x: any) => ({ id: 'uuid-1', ...x })),
      save: jest.fn(async (x: any) => x),
      update: jest.fn(async (_where: any, patch: any) => { Object.assign(repo.currentDoc, patch); return { affected: 1 }; }),
      remove: jest.fn(),
      currentDoc: null,
    };
    assets = {
      ensureCanvasPartition: jest.fn(async () => undefined),
      deleteCanvas: jest.fn(async () => undefined),
      getCanvasAssetSizes: jest.fn(async () => ({})),
      deleteGeneratedByNode: jest.fn(async () => undefined),
    };
    leases = { findOne: jest.fn(async () => ({ canvasId: 'c1', epoch: 1, holderType: 'human', holderId: 'h1', tokenHash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', status: 'active', expiresAt: new Date(Date.now() + 60000), serverInstanceId: '' })), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) };
    receipts = { findOne: jest.fn(async () => null), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) };
    repo.manager = {
      transaction: jest.fn(async (work: any) => work({
        getRepository: (entity: any) => entity === CanvasDoc
          ? { findOne: repo.findOne, findOneOrFail: jest.fn(async () => repo.currentDoc), update: repo.update }
          : entity === CanvasOperationLog ? { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) }
            : entity === CanvasAssetGcJob ? { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) }
            : entity === Workflow ? { findByIds: jest.fn(async () => []) } : receipts,
      })),
    };
    service = new CanvasService(repo as any, leases as any, receipts as any, { find: jest.fn(), findOne: jest.fn(), save: jest.fn() } as any, { find: jest.fn(), findOne: jest.fn(), save: jest.fn(), create: jest.fn() } as any, { find: jest.fn(async () => []), delete: jest.fn(), save: jest.fn(), create: jest.fn() } as any, assets as any);
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
        baseDoc({ id: 'c1', graph: { ...emptyCanvasGraph(), nodes: [{ id: 'n1', type: 'result', position: { x: 0, y: 0 }, data: {} }, { id: 'n2', type: 'result', position: { x: 1, y: 1 }, data: {} }] } }),
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
      repo.currentDoc = d;
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
      repo.currentDoc = d;
      repo.findOne.mockResolvedValue(d);
      const graph: CanvasGraph = {
        version: 1,
        nodes: [{ id: 'n1', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image' } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      await service.update('c1', { name: ' 新名字 ', graph, leaseToken: 'a', leaseEpoch: 1, expectedRevision: 0, idempotencyKey: 'k1' });
      expect(d.name).toBe('新名字');
      expect(d.graph).toEqual(graph);
      expect(repo.update).toHaveBeenCalledWith({ id: 'c1', revision: 0 }, expect.objectContaining({ name: '新名字', graph }));
    });

    it('空名抛 BadRequest', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await expect(service.update('c1', { name: '   ', leaseToken: 'a', leaseEpoch: 1, expectedRevision: 0, idempotencyKey: 'k2' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('非法 graph 抛 BadRequest', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await expect(
        service.update('c1', {
          graph: { version: 'x', nodes: [], edges: [] }, leaseToken: 'a', leaseEpoch: 1, expectedRevision: 0, idempotencyKey: 'k3'
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('级联删除资产并删画布', async () => {
      const d = baseDoc();
      repo.findOne.mockResolvedValue(d);
      await service.remove('c1', { leaseToken: 'a', leaseEpoch: 1, expectedRevision: 0 });
      expect(assets.deleteCanvas).toHaveBeenCalledWith('c1');
      expect(repo.remove).toHaveBeenCalledWith(d);
    });

    it('不存在抛 NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('nope', { leaseToken: 'a', leaseEpoch: 1, expectedRevision: 0 })).rejects.toThrow(NotFoundException);
    });
  });
});
