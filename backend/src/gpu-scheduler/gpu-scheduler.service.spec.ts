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

  it('keeps competing providers queued throughout a CPU-only stage', async () => {
    const evaluation = await service.acquire('speech-evaluator', 'eval-cpu-stage');
    let competingGranted = false;
    const competing = service.acquire('comfyui', 'comfy-waiting').then((lease) => { competingGranted = true; return lease; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(competingGranted).toBe(false);
    expect(service.getState()).toMatchObject({ active: { provider: 'speech-evaluator' }, waiting: [{ provider: 'comfyui' }] });
    await evaluation.release();
    const comfy = await competing;
    expect(competingGranted).toBe(true);
    await comfy.release();
  });

  it('fails closed when a previous provider process cannot be proven absent', async () => {
    service.registerProvider('speech-evaluator', { prepare: async () => { throw Object.assign(new Error('unconfirmed'), { details: { code: 'PROVIDER_STATE_UNCONFIRMED', pid: 4321 } }); }, release: async () => undefined });
    await expect(service.acquire('speech-evaluator', 'eval-restart')).rejects.toThrow('unconfirmed');
    expect(service.getState().blocked).toMatchObject({ code: 'PROVIDER_STATE_UNCONFIRMED', pid: 4321 });
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
