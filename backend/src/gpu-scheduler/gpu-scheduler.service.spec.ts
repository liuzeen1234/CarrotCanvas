import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalComputeLease } from './gpu-resource-lease.entity';
import { LocalComputeSchedulerService } from './gpu-scheduler.service';
import { SystemResourcesService } from '../system-resources/system-resources.service';
import { SettingsService } from '../settings/settings.service';

describe('LocalComputeSchedulerService', () => {
  let service: LocalComputeSchedulerService;
  let temperatures: Array<number | null>;
  let settings: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    temperatures = [40];
    settings = { get: jest.fn(async () => null), set: jest.fn(async (_key, value) => ({ value })) };
    const resources = { snapshot: jest.fn(async () => {
      const temperatureC = temperatures.length > 1 ? temperatures.shift()! : temperatures[0];
      return { sampledAt: Date.now(), gpu: { devices: [{ index: 0, temperatureC }], error: temperatureC == null ? 'unavailable' : null } };
    }) };
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', dropSchema: true, entities: [LocalComputeLease], synchronize: true }),
        TypeOrmModule.forFeature([LocalComputeLease]),
      ],
      providers: [
        LocalComputeSchedulerService,
        { provide: SystemResourcesService, useValue: resources },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    service = module.get(LocalComputeSchedulerService);
    await service.onModuleInit();
  });

  it('never grants two local heavy-compute leases at the same time', async () => {
    const first = await service.acquire('comfyui', 'run-1');
    let secondGranted = false;
    const secondPromise = service.acquire('cosyvoice3', 'run-2').then((lease) => {
      secondGranted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondGranted).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(second.lease.runId).toBe('run-2');
    await second.release();
  });

  it('keeps the same provider resident and releases it once when switching', async () => {
    const events: string[] = [];
    service.registerProvider('comfyui', { prepare: async () => { events.push('prepare-comfy'); }, release: async () => { events.push('release-comfy'); } });
    service.registerProvider('indextts2', { prepare: async () => { events.push('prepare-index'); }, release: async () => { events.push('release-index'); } });
    const one = await service.acquire('comfyui', 'run-1'); await one.release();
    const two = await service.acquire('comfyui', 'run-2'); await two.release();
    const three = await service.acquire('indextts2', 'run-3'); await three.release();
    expect(events).toEqual(['prepare-comfy', 'prepare-comfy', 'release-comfy', 'prepare-index']);
  });

  it('fails closed after an incomplete provider release and rejects queued work', async () => {
    const releaseError = Object.assign(new Error('still resident'), {
      details: { code: 'PROVIDER_RELEASE_FAILED', provider: 'comfyui', attempts: [1, 2, 3] },
    });
    service.registerProvider('comfyui', { prepare: async () => undefined, release: async () => { throw releaseError; } });
    service.registerProvider('cosyvoice3', { prepare: async () => undefined, release: async () => undefined });
    const first = await service.acquire('comfyui', 'run-1');
    await first.release();
    await expect(service.acquire('cosyvoice3', 'run-2')).rejects.toThrow('still resident');
    expect(service.getState().blocked).toMatchObject({ code: 'PROVIDER_RELEASE_FAILED', provider: 'comfyui' });
    await expect(service.acquire('indextts2', 'run-3')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PROVIDER_RELEASE_FAILED' }) });
  });

  it('can resume only after the explicit block is cleared', async () => {
    service.registerProvider('comfyui', { prepare: async () => { throw new ConflictException({ code: 'COMFYUI_TAKEOVER_REQUIRED', message: 'confirm' }); }, release: async () => undefined });
    await expect(service.acquire('comfyui', 'run-1')).rejects.toThrow();
    expect(service.getState().blocked).toMatchObject({ code: 'COMFYUI_TAKEOVER_REQUIRED' });
    service.registerProvider('comfyui', { prepare: async () => undefined, release: async () => undefined });
    service.clearBlock();
    const lease = await service.acquire('comfyui', 'run-2');
    expect(lease.lease.status).toBe('active');
    await lease.release();
  });

  it('waits for the configured cooldown and grants only after GPU 0 reaches the threshold', async () => {
    temperatures = [71, 58, 50];
    await service.updateThermalPolicy({ maxWaitRounds: 3, retryIntervalMs: 1_000 });
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    const lease = await service.acquire('comfyui', 'cooling-run');
    expect(lease.lease.status).toBe('active');
    expect(service.getState().thermal).toMatchObject({
      policy: { thresholdC: 50, maxWaitRounds: 3 },
      state: { status: 'idle', temperatureC: 50, waitedRounds: 2 },
    });
    await lease.release();
  });

  it('fails the current run and the whole waiting batch after the cooldown limit', async () => {
    temperatures = [71];
    await service.updateThermalPolicy({ maxWaitRounds: 2, retryIntervalMs: 1_000 });
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    const first = service.acquire('comfyui', 'hot-1');
    const second = service.acquire('comfyui', 'hot-2');
    await expect(first).rejects.toMatchObject({ response: expect.objectContaining({
      code: 'GPU_COOLDOWN_TIMEOUT', lastTemperatureC: 71, waitedRounds: 2, waitedMs: 2_000,
    }) });
    await expect(second).rejects.toMatchObject({ response: expect.objectContaining({ code: 'GPU_COOLDOWN_TIMEOUT' }) });
    expect(service.getState()).toMatchObject({ waiting: [], blocked: null, thermal: { state: { status: 'timed_out' } } });
  });

  it('fails closed for the batch when GPU temperature telemetry stays unavailable', async () => {
    temperatures = [null];
    await service.updateThermalPolicy({ maxWaitRounds: 1, retryIntervalMs: 1_000 });
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    await expect(service.acquire('qwen3tts', 'unknown-temperature')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GPU_TEMPERATURE_UNAVAILABLE', waitedRounds: 1 }),
    });
  });

  it('does not delay lightweight ComfyUI service warmup leases', async () => {
    temperatures = [80];
    const snapshot = jest.spyOn((service as any).resources, 'snapshot');
    const lease = await service.acquire('comfyui', 'startup:warmup');
    expect(snapshot).not.toHaveBeenCalled();
    await lease.release();
  });

});
