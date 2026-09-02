import { ComfyUIAssetCaptureService } from './comfyui-capture.service';
import type { RunState, RunOutputFile } from './comfyui-runner.service';

/** 构造最小 run 状态 */
function makeRun(outputs: RunOutputFile[]): RunState {
  return {
    promptId: 'prompt-1',
    title: '测试运行',
    status: 'success',
    queuedAt: 1,
    nodes: {},
    nodeTitles: {},
    outputs,
    nodeErrors: {},
  };
}

function makeOutput(over: Partial<RunOutputFile> = {}): RunOutputFile {
  return {
    filename: 'ComfyUI_00001_.png',
    subfolder: '',
    type: 'output',
    url: '/api/comfyui/view?filename=ComfyUI_00001_.png&type=output',
    kind: 'image',
    ...over,
  };
}

function makeClient(over: any = {}) {
  return {
    fetchViewFile: jest.fn(async () => ({ buffer: Buffer.from('img'), mime: 'image/png' })),
    ...over,
  };
}

function makeAssets(over: any = {}) {
  const assets = {
    saveGenerated: jest.fn(async (input: any) => ({
      id: `asset-${input.originName}`,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      source: 'generated',
      kind: input.kind,
    })),
    deleteGeneratedByNode: jest.fn(async () => undefined),
    ...over,
  };
  return assets;
}

describe('ComfyUIAssetCaptureService', () => {
  it('全部输出捕获成功 → 回填 assetId/assetUrl，并按节点覆盖清理旧产物（先建新后清旧）', async () => {
    const client = makeClient();
    const assets = makeAssets();
    const svc = new ComfyUIAssetCaptureService(client as any, assets as any);
    const run = makeRun([makeOutput(), makeOutput({ filename: 'ComfyUI_00002_.png' })]);

    await svc.captureRunOutputs(run, 'canvas-1', 'node-1', 'wf-1');

    expect(client.fetchViewFile).toHaveBeenCalledTimes(2);
    expect(assets.saveGenerated).toHaveBeenCalledTimes(2);
    expect(assets.saveGenerated).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'canvas-1',
        nodeId: 'node-1',
        runPromptId: 'prompt-1',
        workflowId: 'wf-1',
        kind: 'image',
        originName: 'ComfyUI_00001_.png',
        mime: 'image/png',
      }),
    );
    // 先建新、后清旧（§4.6.4），且保留本次新捕获的 assetId
    const saveOrder = assets.saveGenerated.mock.invocationCallOrder[0];
    const clearOrder = assets.deleteGeneratedByNode.mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(clearOrder);
    expect(assets.deleteGeneratedByNode).toHaveBeenCalledWith(
      'canvas-1',
      'node-1',
      expect.arrayContaining(['asset-ComfyUI_00001_.png', 'asset-ComfyUI_00002_.png']),
    );
    // 回填 outputs
    expect(run.outputs[0].assetId).toMatch(/^asset-/);
    expect(run.outputs[0].assetUrl).toMatch(/^\/api\/assets\//);
  });

  it('部分输出捕获失败 → 不清旧产物（保留上一版），已捕获部分仍回填', async () => {
    const client = makeClient({
      fetchViewFile: jest
        .fn()
        .mockResolvedValueOnce({ buffer: Buffer.from('ok'), mime: 'image/png' })
        .mockRejectedValueOnce(new Error('上游 500')),
    });
    const assets = makeAssets();
    const svc = new ComfyUIAssetCaptureService(client as any, assets as any);
    const run = makeRun([
      makeOutput(),
      makeOutput({ filename: 'ComfyUI_00002_.png' }),
    ]);

    await svc.captureRunOutputs(run, 'canvas-1', 'node-1', 'wf-1');

    expect(assets.saveGenerated).toHaveBeenCalledTimes(1);
    expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
    expect(run.outputs[0].assetId).toMatch(/^asset-/);
    expect(run.outputs[1].assetId).toBeUndefined();
  });

  it('kind=other 的输出跳过，不捕获也不清理', async () => {
    const client = makeClient();
    const assets = makeAssets();
    const svc = new ComfyUIAssetCaptureService(client as any, assets as any);
    const run = makeRun([makeOutput({ kind: 'other' })]);

    await svc.captureRunOutputs(run, 'canvas-1', 'node-1', 'wf-1');

    expect(client.fetchViewFile).not.toHaveBeenCalled();
    expect(assets.saveGenerated).not.toHaveBeenCalled();
    expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
  });

  it('未指定 nodeId → 仍捕获，但不做覆盖清理', async () => {
    const client = makeClient();
    const assets = makeAssets();
    const svc = new ComfyUIAssetCaptureService(client as any, assets as any);
    const run = makeRun([makeOutput()]);

    await svc.captureRunOutputs(run, 'canvas-1', null, 'wf-1');

    expect(assets.saveGenerated).toHaveBeenCalledTimes(1);
    expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
    expect(run.outputs[0].assetUrl).toMatch(/^\/api\/assets\//);
  });

  it('无可用输出 → 直接返回，不捕获不清理', async () => {
    const client = makeClient();
    const assets = makeAssets();
    const svc = new ComfyUIAssetCaptureService(client as any, assets as any);
    const run = makeRun([]);

    await svc.captureRunOutputs(run, 'canvas-1', 'node-1', 'wf-1');

    expect(client.fetchViewFile).not.toHaveBeenCalled();
    expect(assets.saveGenerated).not.toHaveBeenCalled();
    expect(assets.deleteGeneratedByNode).not.toHaveBeenCalled();
  });
});
