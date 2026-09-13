import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from '../../backend/node_modules/typeorm';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from '../../backend/src/canvas/canvas.entity';
import { CanvasService } from '../../backend/src/canvas/canvas.service';
import { Workflow } from '../../backend/src/workflows/workflow.entity';

const root = resolve(__dirname, '../..');
const codex = readFileSync(resolve(root, 'web/src/components/canvas/nodes/CodexCapabilityNode.tsx'), 'utf8');
const comfy = readFileSync(resolve(root, 'web/src/components/canvas/nodes/Txt2ImgNode.tsx'), 'utf8');
// Execute the actual component assembly expressions, without mounting React or calling providers.
const codexExpression = codex.split('const references = useMemo(() => ')[1].split(', [connectedReferences')[0];
const comfyExpression = comfy.split('const references = [...connected, ...embedded, ...uploaded]')[1].split('return { config, connected')[0].trim().replace(/;$/, '');
const assembleCodex = new Function('connectedReferences', 'uploadedReferences', 'referenceOrder', `return ${codexExpression}`);
const assembleComfy = new Function('connected', 'embedded', 'uploaded', 'order', `return [...connected, ...embedded, ...uploaded]${comfyExpression}`);
const a = { referenceId: 'edge-a', assetId: 'same-asset', displayName: '角色', url: '/api/assets/same-asset', kind: 'image' };
const b = { referenceId: 'asset:same-asset', assetId: 'same-asset', displayName: '上传', url: '/api/assets/same-asset', kind: 'image' };
const c = { ...a, referenceId: 'edge-c', displayName: '另一连线' };
const stale = { ...a, assetId: 'stale-asset' };

describe('Reference storage contract without generation', () => {
  it('actual Codex assembly covers connected, upload, mixed, legacy duplicates, reorder and same-asset identities', () => {
    expect(assembleCodex([a], [], [])).toEqual([a]);
    expect(assembleCodex([], [b], [])).toEqual([b]);
    expect(assembleCodex([a], [b], [b.referenceId, a.referenceId])).toEqual([b, a]);
    const refs = assembleCodex([a, c], [stale, b, b], [b.referenceId, a.referenceId, a.referenceId]);
    expect(refs).toEqual([b, a, c]);
    const bindings = [{ referenceId: a.referenceId, token: '@角色', displayName: a.displayName }];
    const activeBindings = bindings;
    const references = refs;
    const compileBody = codex.split('const compilePrompt = (prompt: string) => {')[1].split('\n  };')[0];
    const compile = new Function('activeBindings', 'references', 'prompt', compileBody);
    expect(compile(activeBindings, references, '使用 @角色')).toContain('使用 第 2 张输入图片（角色）');
    const files = refs.map((r: any) => r.url);
    const ids = refs.map((r: any) => r.assetId);
    const map = refs.map((r: any, index: number) => ({ referenceId: r.referenceId, assetId: r.assetId, position: index + 1 }));
    expect(files).toHaveLength(3);
    expect(ids).toEqual(['same-asset', 'same-asset', 'same-asset']);
    expect(map.map((r: any) => r.position)).toEqual([1, 2, 3]);
    expect(assembleCodex([a, c], [b], [c.referenceId, b.referenceId, a.referenceId])).toEqual([c, b, a]);
  });

  it('actual ComfyUI assembly preserves file references and distinct same-asset slots', () => {
    const field = { referenceId: 'field:images:137::image', assetId: '', filename: 'existing.png' };
    expect(assembleComfy([a, c], [field], [stale, b, b], [b.referenceId, field.referenceId, a.referenceId])).toEqual([b, field, a, c]);
    expect(comfy).toContain('const inputAssetIds = new Set<string>()');
    expect(assembleComfy([], [], [b], [])).toEqual([b]);
    expect(assembleComfy([a], [], [], [])).toEqual([a]);
  });

  it('mixed documentation example stores only uploads and orders/binds the edge', () => {
    const doc = readFileSync(resolve(root, 'skills/carrot-canvas/references/operations.md'), 'utf8');
    const example = doc.split('### Codex 多图与稳定引用')[1].split('```js')[1].split('```')[0];
    const data = new Function(`return (${example})`)();
    expect(data.referenceImages.map((r: any) => r.referenceId)).toEqual(['asset:uploaded-asset-id']);
    expect(data.referenceImageOrder).toEqual(['edge-ref-character', 'asset:uploaded-asset-id']);
    expect(data.promptImageReferences[0].edgeId).toBe('edge-ref-character');
  });

  it('normal lease + update_node removes legacy copies while preserving edges, ordering, binding and output', async () => {
    const db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow], synchronize: true });
    await db.initialize();
    try {
      const assets = { ensureCanvasPartition: jest.fn(), getCanvasAssetSizes: jest.fn(async () => ({})), deleteGeneratedByNode: jest.fn() };
      const service = new CanvasService(db.getRepository(CanvasDoc), db.getRepository(CanvasControlLease), db.getRepository(CanvasOperationReceipt), db.getRepository(CanvasOperationLog), db.getRepository(CanvasCheckpoint), db.getRepository(CanvasAssetGcJob), assets as any);
      const canvas = await service.create({ name: 'Reference contract fixture' });
      const lease = await service.acquire(canvas.id, { holderType: 'agent', holderId: 'reference-contract' });
      const proof = (revision: number, key: string) => ({ leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: revision, idempotencyKey: key, actorType: 'agent' as const, actorId: 'reference-contract' });
      const data = { capability: 'edit', prompt: '使用 @角色', model: 'codex', referenceImages: [stale, b, b], referenceImageOrder: [b.referenceId, a.referenceId], promptImageReferences: [{ referenceId: a.referenceId, edgeId: a.referenceId, sourceNodeId: 'source', token: '@角色', displayName: '角色' }], lastAssets: [{ ...b, assetId: 'output-asset' }], lastText: '保留文字', lastTextParts: { positive: '保留', negative: '保留' } };
      const repo = db.getRepository(Workflow);
      const workflow = await repo.save(repo.create({ name: 'Reference fixture', category: 'reference', apiJson: JSON.stringify({ '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } }), inputConfig: { version: 1, fields: [] } }));
      const comfyData = { workflowId: workflow.id, formValues: { '138::value': '使用 @角色', '137::image': 'existing.png' }, referenceImages: [stale], referenceMedia: { images: [stale, b, b], videos: [], videoAudios: [], audios: [{ ...b, kind: 'audio', referenceId: 'asset:audio' }] }, referenceMediaOrder: { images: [b.referenceId, a.referenceId] }, promptMediaReferences: [{ ...data.promptImageReferences[0], group: 'images' }], lastAssets: data.lastAssets };
      const setup = await service.applyOperations(canvas.id, { ...proof(0, 'setup'), operations: [
        { type: 'create_node', node: { id: 'source', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'image', inputMode: true, lastAssets: [a] } } },
        { type: 'create_node', node: { id: 'edit', type: 'codex-capability', position: { x: 300, y: 0 }, data } },
        { type: 'connect', edge: { id: a.referenceId, source: 'source', sourceHandle: 'image-source', target: 'edit', targetHandle: 'image-target' } },
        { type: 'create_node', node: { id: 'comfy', type: 'txt2img', position: { x: 300, y: 300 }, data: comfyData } },
        { type: 'connect', edge: { id: 'comfy-edge', source: 'source', sourceHandle: 'image-source', target: 'comfy', targetHandle: 'input:image:reference-group:images' } },
      ] });
      await expect(service.applyOperations(canvas.id, { ...proof(1, 'no-lease'), leaseToken: '', operations: [{ type: 'update_node', nodeId: 'edit', dataPatch: { referenceImages: [b] } }] })).rejects.toBeDefined();
      const clean = await service.applyOperations(canvas.id, { ...proof(1, 'clean'), operations: [{ type: 'update_node', nodeId: 'edit', dataPatch: { referenceImages: [b] } }] });
      expect(clean.canvas.graph.edges).toEqual(setup.canvas.graph.edges);
      expect(clean.canvas.graph.nodes.find(n => n.id === 'edit')!.data).toEqual({ ...data, referenceImages: [b] });
      expect(assembleCodex([a], data.referenceImages, data.referenceImageOrder)).toEqual(assembleCodex([a], [b], data.referenceImageOrder));
      // Use the actual connected edge identity for the legacy ComfyUI copies.
      const comfyLegacy = { ...stale, referenceId: 'comfy-edge' };
      const legacyComfyData = { ...comfyData, referenceImages: [comfyLegacy], referenceMedia: { ...comfyData.referenceMedia, images: [comfyLegacy, b, b] }, referenceMediaOrder: { images: [b.referenceId, 'comfy-edge'] }, promptMediaReferences: [{ ...comfyData.promptMediaReferences[0], referenceId: 'comfy-edge', edgeId: 'comfy-edge' }] };
      await service.applyOperations(canvas.id, { ...proof(2, 'comfy-legacy'), operations: [{ type: 'update_node', nodeId: 'comfy', dataPatch: legacyComfyData }] });
      const comfyClean = await service.applyOperations(canvas.id, { ...proof(3, 'comfy-clean'), operations: [{ type: 'update_node', nodeId: 'comfy', dataPatch: { referenceImages: [], referenceMedia: { ...legacyComfyData.referenceMedia, images: [b] } } }] });
      expect(comfyClean.canvas.graph.edges).toEqual(setup.canvas.graph.edges);
      expect(comfyClean.canvas.graph.nodes.find(n => n.id === 'comfy')!.data).toEqual({ ...legacyComfyData, referenceImages: [], referenceMedia: { ...legacyComfyData.referenceMedia, images: [b] } });
      await service.release(canvas.id, { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch });
      expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
    } finally { await db.destroy(); }
  });
});
