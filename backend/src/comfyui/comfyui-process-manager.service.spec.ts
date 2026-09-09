import { ConflictException } from '@nestjs/common';
import { ComfyUIProcessManagerService } from './comfyui-process-manager.service';

const owner = (pid: number) => ({ pid, name: 'python', path: 'D:\\Comfy\\python.exe', workingSetBytes: 10, privateBytes: 20 });
const snapshot = (pid: number | null, desktop: number[] = []) => ({
  port: 8188, portOwner: pid ? owner(pid) : null,
  desktopProcesses: desktop.map((id) => ({ ...owner(id), name: 'Comfy Desktop' })),
  allocator: null, globalGpuMemoryUsedBytes: 123,
});

describe('ComfyUIProcessManagerService', () => {
  const settings = { get: jest.fn(), set: jest.fn(async () => undefined) } as any;
  const client = { getSystemStats: jest.fn(async () => ({ system: { argv: ['ComfyUI\\main.py'] } })) } as any;

  beforeEach(() => jest.clearAllMocks());

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
