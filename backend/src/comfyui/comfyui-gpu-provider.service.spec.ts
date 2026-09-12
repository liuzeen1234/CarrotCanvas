import { ComfyUIGpuProviderService } from './comfyui-gpu-provider.service';

describe('ComfyUIGpuProviderService', () => {
  function setup() {
    let lifecycle: { prepare(): Promise<void>; release(): Promise<void> } | undefined;
    const scheduler = { registerProvider: jest.fn((_name, value) => { lifecycle = value; }) } as any;
    const client = {
      getQueue: jest.fn(async () => ({ queue_running: [], queue_pending: [] })),
      freeMemory: jest.fn(async () => undefined),
      waitForModelsUnloaded: jest.fn(async () => undefined),
    } as any;
    const processes = { ensureManagedRunning: jest.fn(), releaseManaged: jest.fn(async () => undefined) } as any;
    const service = new ComfyUIGpuProviderService(scheduler, client, processes);
    service.onModuleInit();
    return { lifecycle: lifecycle!, client, processes };
  }

  it('unloads models while keeping the healthy ComfyUI service online', async () => {
    const { lifecycle, client, processes } = setup();
    await lifecycle.release();
    expect(client.freeMemory).toHaveBeenCalledTimes(1);
    expect(client.waitForModelsUnloaded).toHaveBeenCalledTimes(1);
    expect(processes.releaseManaged).not.toHaveBeenCalled();
  });

  it('stops the managed process when model unloading cannot be verified', async () => {
    const { lifecycle, client, processes } = setup();
    client.waitForModelsUnloaded.mockRejectedValue(new Error('allocator still busy'));
    await lifecycle.release();
    expect(processes.releaseManaged).toHaveBeenCalledTimes(1);
  });
});
