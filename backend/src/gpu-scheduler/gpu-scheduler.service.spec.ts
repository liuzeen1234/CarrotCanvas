import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GpuResourceLease } from './gpu-resource-lease.entity';
import { GpuSchedulerService } from './gpu-scheduler.service';

describe('GpuSchedulerService', () => {
  let service: GpuSchedulerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', dropSchema: true, entities: [GpuResourceLease], synchronize: true }),
        TypeOrmModule.forFeature([GpuResourceLease]),
      ],
      providers: [GpuSchedulerService],
    }).compile();
    service = module.get(GpuSchedulerService);
    await service.onModuleInit();
  });

  it('never grants two GPU leases at the same time', async () => {
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

  it('cleans up a non-resident heavy provider before granting the next lease', async () => {
    const events: string[] = [];
    service.registerProvider('speech-evaluator', { retainAfterLease: false, prepare: async () => { events.push('prepare-eval'); }, release: async () => { events.push('release-eval'); } });
    service.registerProvider('comfyui', { prepare: async () => { events.push('prepare-comfy'); }, release: async () => { events.push('release-comfy'); } });
    const evaluation = await service.acquire('speech-evaluator', 'eval'); await evaluation.release();
    expect(service.getState().residentProvider).toBeNull();
    const comfy = await service.acquire('comfyui', 'comfy'); await comfy.release();
    expect(events).toEqual(['prepare-eval', 'release-eval', 'prepare-comfy']);
  });
});
