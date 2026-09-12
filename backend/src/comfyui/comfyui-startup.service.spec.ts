import { ComfyUIStartupService } from './comfyui-startup.service';

describe('ComfyUIStartupService', () => {
  const emptyInspection = { port: 8188, portOwner: null, desktopProcesses: [], allocator: null, globalGpuMemoryUsedBytes: null };

  afterEach(() => jest.restoreAllMocks());

  it('warms a configured managed backend through the scheduler', async () => {
    const release = jest.fn(async () => undefined);
    const settings = { get: jest.fn(async (key: string) => ({ value: key === 'comfyui-always-managed' ? 'true' : '{"configured":true}' })) } as any;
    const processes = { inspect: jest.fn(async () => emptyInspection), isManagedRunning: jest.fn(async () => false) } as any;
    const scheduler = { acquire: jest.fn(async () => ({ release })) } as any;
    const service = new ComfyUIStartupService(settings, processes, scheduler);

    await expect(service.warmup()).resolves.toMatchObject({ started: true });
    expect(scheduler.acquire).toHaveBeenCalledWith('comfyui', expect.stringMatching(/^startup:/));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not start when autostart is disabled or another ComfyUI is present', async () => {
    const scheduler = { acquire: jest.fn() } as any;
    const disabled = new ComfyUIStartupService(
      { get: jest.fn(async () => ({ value: 'false' })) } as any,
      { inspect: jest.fn() } as any,
      scheduler,
    );
    await expect(disabled.warmup()).resolves.toMatchObject({ reason: 'not-configured' });

    const present = new ComfyUIStartupService(
      { get: jest.fn(async (key: string) => ({ value: key === 'comfyui-always-managed' ? 'true' : '{}' })) } as any,
      { inspect: jest.fn(async () => ({ ...emptyInspection, portOwner: { pid: 42 } })), isManagedRunning: jest.fn(async () => false) } as any,
      scheduler,
    );
    await expect(present.warmup()).resolves.toMatchObject({ reason: 'already-present' });
    expect(scheduler.acquire).not.toHaveBeenCalled();
  });

  it('registers an already-running managed backend as the resident provider', async () => {
    const release = jest.fn(async () => undefined);
    const inspection = { ...emptyInspection, portOwner: { pid: 42 } };
    const service = new ComfyUIStartupService(
      { get: jest.fn(async (key: string) => ({ value: key === 'comfyui-always-managed' ? 'true' : '{}' })) } as any,
      { inspect: jest.fn(async () => inspection), isManagedRunning: jest.fn(async () => true) } as any,
      { acquire: jest.fn(async () => ({ release })) } as any,
    );
    await expect(service.warmup()).resolves.toMatchObject({ reason: 'already-managed' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
