import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AssetsService as AssetsServiceType } from './assets.service';

let ASSETS_ROOT: string;
let AssetsService: new (repo: any, checkpoints?: any) => AssetsServiceType;
let safeName: (name: string | null | undefined, fallback: string) => string;

/** 构造 mock 仓库（TypeORM Repository 的子集） */
function makeRepo(over: any = {}) {
  return {
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => x),
    findOne: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...over,
  };
}

beforeAll(() => {
  // 用临时目录隔离真实 data/assets，需在 require 模块前设置环境变量
  ASSETS_ROOT = mkdtempSync(join(tmpdir(), 'cc-assets-test-'));
  process.env.CARROT_ASSETS_ROOT = ASSETS_ROOT;
  jest.resetModules();
  const mod = require('./assets.service') as typeof import('./assets.service');
  AssetsService = mod.AssetsService;
  safeName = mod.safeName;
});

afterAll(() => {
  rmSync(ASSETS_ROOT, { recursive: true, force: true });
});

describe('AssetsService', () => {
  describe('saveGenerated', () => {
    it('写入 generated 分区并建行（source=generated）', async () => {
      const repo = makeRepo();
      const service = new AssetsService(repo);
      const asset = await service.saveGenerated({
        canvasId: 'c1',
        nodeId: 'n1',
        runPromptId: 'run-1',
        workflowId: 'wf-1',
        kind: 'image',
        buffer: Buffer.from('hello', 'utf8'),
        originName: 'a b.png',
        mime: 'image/png',
      });
      expect(asset.canvasId).toBe('c1');
      expect(asset.source).toBe('generated');
      expect(asset.kind).toBe('image');
      expect(asset.relPath).toMatch(/^generated\/.+__a b\.png$/);
      expect(asset.size).toBe(5);
      // 磁盘文件真实落盘
      const abs = join(ASSETS_ROOT, 'c1', asset.relPath);
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toBe('hello');
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ source: 'generated' }));
    });
  });

  describe('saveUpload', () => {
    it('写入 upload 分区并建行（source=upload）', async () => {
      const repo = makeRepo();
      const service = new AssetsService(repo);
      const asset = await service.saveUpload({
        canvasId: 'c1',
        buffer: Buffer.from('img'),
        originName: 'ref.png',
        mime: 'image/png',
      });
      expect(asset.relPath).toMatch(/^upload\/.+__ref\.png$/);
      expect(asset.source).toBe('upload');
      expect(existsSync(join(ASSETS_ROOT, 'c1', asset.relPath))).toBe(true);
    });
  });

  describe('read', () => {
    it('存在且文件在盘 → 返回 asset 与绝对路径', async () => {
      const repo = makeRepo();
      const service = new AssetsService(repo);
      const created = await service.saveGenerated({
        canvasId: 'c1',
        buffer: Buffer.from('x'),
        originName: 'f.png',
      });
      repo.findOne.mockResolvedValue(created);
      const { asset, absPath } = await service.read(created.id);
      expect(asset.id).toBe(created.id);
      expect(existsSync(absPath)).toBe(true);
    });

    it('asset 行不存在 → NotFound', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue(null);
      const service = new AssetsService(repo);
      await expect(service.read('nope')).rejects.toThrow('不存在');
    });

    it('行在但文件被删 → NotFound', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({
        id: 'a1',
        canvasId: 'c1',
        relPath: 'generated/a1__missing.png',
      });
      const service = new AssetsService(repo);
      await expect(service.read('a1')).rejects.toThrow('不存在');
    });

    it('防目录穿越：relPath 越出分区 → BadRequest', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({
        id: 'a1',
        canvasId: 'c1',
        relPath: '../../../evil.png',
      });
      const service = new AssetsService(repo);
      await expect(service.read('a1')).rejects.toThrow('非法的资产路径');
    });
  });

  describe('deleteCanvas', () => {
    it('删 asset 行 + 整分区目录', async () => {
      const repo = makeRepo();
      const service = new AssetsService(repo);
      await service.saveGenerated({ canvasId: 'c2', buffer: Buffer.from('x'), originName: 'f.png' });
      await service.deleteCanvas('c2');
      expect(repo.delete).toHaveBeenCalledWith({ canvasId: 'c2' });
      expect(existsSync(join(ASSETS_ROOT, 'c2'))).toBe(false);
    });
  });

  describe('deleteGeneratedByNode', () => {
    it('只清该节点 generated 资产（行 + 文件）', async () => {
      const repo = makeRepo();
      const g1 = 'generated/g1__a.png';
      const g2 = 'generated/g2__b.png';
      const dir = join(ASSETS_ROOT, 'c1', 'generated');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(ASSETS_ROOT, 'c1', g1), 'x');
      writeFileSync(join(ASSETS_ROOT, 'c1', g2), 'x');
      repo.find.mockResolvedValue([
        { id: 'g1', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: g1 },
        { id: 'g2', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: g2 },
      ]);
      const service = new AssetsService(repo);
      await service.deleteGeneratedByNode('c1', 'n1');
      expect(repo.delete).toHaveBeenCalledTimes(2);
      expect(existsSync(join(ASSETS_ROOT, 'c1', g1))).toBe(false);
      expect(existsSync(join(ASSETS_ROOT, 'c1', g2))).toBe(false);
    });

    it('keepIds 指定的新资产被保留，只清旧版', async () => {
      const repo = makeRepo();
      const g1 = 'generated/g1__a.png';
      const g2 = 'generated/g2__b.png';
      const dir = join(ASSETS_ROOT, 'c1', 'generated');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(ASSETS_ROOT, 'c1', g1), 'new');
      writeFileSync(join(ASSETS_ROOT, 'c1', g2), 'old');
      repo.find.mockResolvedValue([
        { id: 'g1', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: g1 },
        { id: 'g2', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: g2 },
      ]);
      const service = new AssetsService(repo);
      // g1 为本次新捕获，保留；g2 为旧版，清除
      await service.deleteGeneratedByNode('c1', 'n1', ['g1']);
      expect(repo.delete).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledWith('g2');
      expect(existsSync(join(ASSETS_ROOT, 'c1', g1))).toBe(true);
      expect(existsSync(join(ASSETS_ROOT, 'c1', g2))).toBe(false);
    });

    it('恢复点引用的旧资产在同节点重跑时仍被保留', async () => {
      const repo = makeRepo();
      const oldPath = 'generated/old__checkpoint.png';
      const newPath = 'generated/new__latest.png';
      const stalePath = 'generated/stale__unused.png';
      const dir = join(ASSETS_ROOT, 'c1', 'generated');
      mkdirSync(dir, { recursive: true });
      for (const relPath of [oldPath, newPath, stalePath]) writeFileSync(join(ASSETS_ROOT, 'c1', relPath), relPath);
      repo.find.mockResolvedValue([
        { id: 'old', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: oldPath },
        { id: 'new', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: newPath },
        { id: 'stale', canvasId: 'c1', nodeId: 'n1', source: 'generated', relPath: stalePath },
      ]);
      const checkpoints = makeRepo({ find: jest.fn(async () => [{
        canvasId: 'c1',
        graph: { version: 1, nodes: [{ id: 'n1', data: { lastAssets: [{ assetId: 'old', url: '/api/assets/old', kind: 'image' }] } }], edges: [], viewport: null },
      }]) });
      const service = new AssetsService(repo, checkpoints);

      await service.deleteGeneratedByNode('c1', 'n1', ['new']);

      expect(checkpoints.find).toHaveBeenCalledWith({ where: { canvasId: 'c1' } });
      expect(repo.delete).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledWith('stale');
      expect(existsSync(join(ASSETS_ROOT, 'c1', oldPath))).toBe(true);
      expect(existsSync(join(ASSETS_ROOT, 'c1', newPath))).toBe(true);
      expect(existsSync(join(ASSETS_ROOT, 'c1', stalePath))).toBe(false);
    });
  });

  describe('getCanvasAssetSizes', () => {
    it('按画布聚合返回总字节数', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { canvasId: 'c1', total: 100 },
          { canvasId: 'c2', total: 50 },
        ]),
      };
      const repo = makeRepo({ createQueryBuilder: jest.fn(() => qb) });
      const service = new AssetsService(repo);
      const sizes = await service.getCanvasAssetSizes();
      expect(sizes).toEqual({ c1: 100, c2: 50 });
    });
  });

  describe('safeName', () => {
    it('清洗路径分隔符与危险字符', () => {
      expect(safeName('a/b\\c:d*e', 'gen')).toBe('a_b_c_d_e');
      expect(safeName('../../etc/passwd', 'gen')).not.toMatch(/\.\./);
      expect(safeName('...', 'gen')).toBe('gen');
      expect(safeName(null, 'gen')).toBe('gen');
      expect(safeName('', 'gen')).toBe('gen');
    });
  });
});
