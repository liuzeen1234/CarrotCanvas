import { ConflictException } from '@nestjs/common';
import { ComfyUIProcessManagerService } from './comfyui-process-manager.service';
import childProcess = require('child_process');
import { EventEmitter } from 'events';

const owner = (pid: number) => ({ pid, name: 'python', path: 'D:\\Comfy\\python.exe', workingSetBytes: 10, privateBytes: 20 });
const snapshot = (pid: number | null, desktop: number[] = []) => ({
  port: 8188, portOwner: pid ? owner(pid) : null,
  desktopProcesses: desktop.map((id) => ({ ...owner(id), name: 'Comfy Desktop' })),
  allocator: null, globalGpuMemoryUsedBytes: 123,
});

describe('ComfyUIProcessManagerService', () => {
  const settings = { get: jest.fn(), set: jest.fn(async () => undefined) } as any;
  const client = { getSystemStats: jest.fn(async () => ({ system: { argv: ['ComfyUI\\main.py'] } })) } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    client.getSystemStats.mockResolvedValue({ system: { argv: ['ComfyUI\\main.py'] } });
  });
  afterEach(() => jest.restoreAllMocks());

  it('does not start a second backend while Desktop is still booting', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    jest.spyOn(service, 'inspect').mockResolvedValue(snapshot(null, [102]));
    const start = jest.spyOn(service as any, 'start');
    const kill = jest.spyOn(service as any, 'killTree');
    await expect(service.ensureManagedRunning()).rejects.toMatchObject({ response: { code: 'COMFYUI_TAKEOVER_REQUIRED' } });
    expect(start).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  });

  it.each([false, true])('cleans up only its own failed boot child (still alive: %s)', async (alive) => {
    const service = new ComfyUIProcessManagerService(settings, client);
    const child = Object.assign(new EventEmitter(), { pid: 901, exitCode: 1 });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as any);
    jest.spyOn(client, 'getSystemStats').mockRejectedValue(new Error('offline'));
    const kill = jest.spyOn(service as any, 'killTree').mockResolvedValue('ok');
    jest.spyOn(service as any, 'processExists').mockResolvedValue(alive);
    const start = (service as any).start({ executable: process.execPath, args: [], cwd: process.cwd() });
    if (alive) await expect(start).rejects.toMatchObject({ details: { code: 'PROVIDER_STATE_UNCONFIRMED', pid: 901 } });
    else await expect(start).rejects.toThrow('提前退出');
    expect(kill).toHaveBeenCalledWith(901);
    expect(kill).toHaveBeenCalledTimes(1);
    if (!alive) expect(settings.set).toHaveBeenCalledWith('comfyui-managed-process', null);
  });

  it('records the Python process that actually owns 8188 after startup', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    const child = Object.assign(new EventEmitter(), { pid: 901, exitCode: null });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as any);
    jest.spyOn(service as any, 'inspectPort').mockResolvedValue(owner(902));
    jest.spyOn(service, 'inspect').mockResolvedValue(snapshot(902));

    await (service as any).start({ executable: process.execPath, args: [], cwd: process.cwd() });

    const [, savedValue] = settings.set.mock.calls.at(-1)!;
    expect(JSON.parse(savedValue)).toMatchObject({
      pid: 902, rootPid: 901, executable: owner(902).path, startedAt: expect.any(Number),
    });
  });

  it('never kills an external 8188 owner without explicit takeover', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    jest.spyOn(service, 'inspect').mockResolvedValue(snapshot(101, [102]));
    const kill = jest.spyOn(service as any, 'killTree');
    await expect(service.ensureManagedRunning()).rejects.toBeInstanceOf(ConflictException);
    expect(kill).not.toHaveBeenCalled();
  });

  it('re-inspects respawned Desktop processes during each takeover attempt', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    jest.spyOn(service as any, 'deriveLaunchSpec').mockReturnValue({ executable: 'python.exe', args: ['main.py'], cwd: 'D:\\Comfy' });
    jest.spyOn(service as any, 'start').mockResolvedValue({ managed: true });
    const inspect = jest.spyOn(service, 'inspect');
    inspect.mockResolvedValueOnce(snapshot(101, [102])); // confirmation snapshot
    inspect.mockResolvedValueOnce(snapshot(101, [102])); // execution revalidation
    inspect.mockResolvedValueOnce(snapshot(101, [102])); // attempt 1 targets
    inspect.mockResolvedValueOnce(snapshot(201, [202])); // respawned
    inspect.mockResolvedValueOnce(snapshot(201, [202])); // attempt 2 targets
    inspect.mockResolvedValueOnce(snapshot(null));
    const kill = jest.spyOn(service as any, 'killTree').mockResolvedValue('ok');
    const confirmation = await service.requestTakeoverConfirmation();
    const result = await service.takeover(confirmation.confirmationToken, true);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([102, 101, 202, 201]);
    expect(result).toMatchObject({ takeover: true, running: { managed: true } });
  });

  it('stops after exactly three failed managed release attempts', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    jest.spyOn(service, 'inspect').mockResolvedValue(snapshot(101));
    jest.spyOn(service as any, 'isManagedProcess').mockResolvedValue(true);
    jest.spyOn(service as any, 'processExists').mockResolvedValue(true);
    const kill = jest.spyOn(service as any, 'killTree').mockResolvedValue('denied');
    await expect(service.releaseManaged()).rejects.toMatchObject({ details: { code: 'PROVIDER_RELEASE_FAILED', provider: 'comfyui' } });
    expect(kill).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('rejects missing, reused, expired and stale confirmation tokens without killing anything', async () => {
    const service = new ComfyUIProcessManagerService(settings, client);
    jest.spyOn(service as any, 'deriveLaunchSpec').mockReturnValue({ executable: 'python.exe', args: ['main.py'], cwd: 'D:\\Comfy' });
    const inspect = jest.spyOn(service, 'inspect').mockResolvedValue(snapshot(101, [102]));
    const kill = jest.spyOn(service as any, 'killTree');
    await expect(service.takeover('', true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_REQUIRED' } });
    await expect(service.takeover('unknown', true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_INVALID' } });

    const reused = await service.requestTakeoverConfirmation();
    (service as any).confirmations.delete(reused.confirmationToken);
    await expect(service.takeover(reused.confirmationToken, true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_INVALID' } });

    const expired = await service.requestTakeoverConfirmation();
    (service as any).confirmations.get(expired.confirmationToken).expiresAt = 0;
    await expect(service.takeover(expired.confirmationToken, true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_EXPIRED' } });

    const stale = await service.requestTakeoverConfirmation();
    inspect.mockResolvedValueOnce(snapshot(201, [202]));
    await expect(service.takeover(stale.confirmationToken, true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_STALE' } });
    await expect(service.takeover(stale.confirmationToken, true)).rejects.toMatchObject({ response: { code: 'TAKEOVER_CONFIRMATION_INVALID' } });
    expect(kill).not.toHaveBeenCalled();
  });
});
