import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalComputeLease } from './gpu-resource-lease.entity';
import { LocalComputeSchedulerService } from './gpu-scheduler.service';

describe('LocalComputeSchedulerService', () => {
  let service: LocalComputeSchedulerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', dropSchema: true, entities: [LocalComputeLease], synchronize: true }),
        TypeOrmModule.forFeature([LocalComputeLease]),
      ],
      providers: [LocalComputeSchedulerService],
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

});
