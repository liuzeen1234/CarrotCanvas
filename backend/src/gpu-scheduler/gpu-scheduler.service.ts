import { ConflictException, HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GpuProvider, GpuResourceLease } from './gpu-resource-lease.entity';

export interface GpuProviderLifecycle {
  prepare(): Promise<void>;
  release(): Promise<void>;
}

export interface GpuLeaseHandle {
  lease: GpuResourceLease;
  release(error?: unknown): Promise<void>;
}

type Waiter = {
  lease: GpuResourceLease;
  resolve: (handle: GpuLeaseHandle) => void;
  reject: (error: unknown) => void;
};

@Injectable()
export class GpuSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(GpuSchedulerService.name);
  private readonly providers = new Map<GpuProvider, GpuProviderLifecycle>();
  private readonly queue: Waiter[] = [];
  private current: GpuResourceLease | null = null;
  private residentProvider: GpuProvider | null = null;
  private advancing = false;
  private blocked: Record<string, unknown> | null = null;

  constructor(@InjectRepository(GpuResourceLease) private readonly leases: Repository<GpuResourceLease>) {}

  async onModuleInit() {
    await this.leases.createQueryBuilder().update().set({
      status: 'abandoned',
      releasedAt: Date.now(),
      error: { code: 'SCHEDULER_RESTARTED', message: '后端重启后资源所有权需要重新核实' },
    }).where('status IN (:...statuses)', { statuses: ['waiting', 'preparing', 'active', 'releasing'] }).execute();
  }

  registerProvider(name: GpuProvider, lifecycle: GpuProviderLifecycle) {
    this.providers.set(name, lifecycle);
  }

  async acquire(provider: GpuProvider, runId: string): Promise<GpuLeaseHandle> {
    if (this.blocked) throw new ConflictException(this.blocked);
    const lease = await this.leases.save(this.leases.create({
      deviceKey: 'cuda:0', runId, provider, status: 'waiting', queuedAt: Date.now(),
      acquiredAt: null, releasedAt: null, error: null,
    }));
    return new Promise<GpuLeaseHandle>((resolve, reject) => {
      this.queue.push({ lease, resolve, reject });
      void this.advance();
    });
  }

  getState() {
    return {
      deviceKey: 'cuda:0',
      active: this.current,
      residentProvider: this.residentProvider,
      waiting: this.queue.map(({ lease }) => lease),
      blocked: this.blocked,
    };
  }

  clearBlock() { this.blocked = null; void this.advance(); }

  private async advance() {
    if (this.advancing || this.current || !this.queue.length) return;
    this.advancing = true;
    const waiter = this.queue.shift()!;
    try {
      waiter.lease.status = 'preparing';
      await this.leases.save(waiter.lease);
      if (this.residentProvider && this.residentProvider !== waiter.lease.provider) {
        await this.providers.get(this.residentProvider)?.release();
        this.residentProvider = null;
      }
      await this.providers.get(waiter.lease.provider)?.prepare();
      this.residentProvider = waiter.lease.provider;
      waiter.lease.status = 'active';
      waiter.lease.acquiredAt = Date.now();
      this.current = await this.leases.save(waiter.lease);
      let released = false;
      waiter.resolve({
        lease: this.current,
        release: async (error?: unknown) => {
          if (released) return;
          released = true;
          const active = this.current;
          if (!active || active.id !== waiter.lease.id) return;
          active.status = error ? 'failed' : 'released';
          active.error = error ? serializeError(error) : null;
          active.releasedAt = Date.now();
          await this.leases.save(active);
          this.current = null;
          void this.advance();
        },
      });
    } catch (error) {
      waiter.lease.status = 'failed';
      waiter.lease.error = serializeError(error);
      waiter.lease.releasedAt = Date.now();
      await this.leases.save(waiter.lease);
      this.logger.error(`GPU Provider ${waiter.lease.provider} 准备失败：${(error as Error).message}`);
      waiter.reject(error);
      const serialized = serializeError(error);
      if (isFailClosed(serialized)) await this.failClosed(serialized);
    } finally {
      this.advancing = false;
      if (!this.current && !this.blocked) void this.advance();
    }
  }

  private async failClosed(reason: Record<string, unknown>) {
    this.blocked = reason;
    const pending = this.queue.splice(0);
    await Promise.all(pending.map(async (waiter) => {
      waiter.lease.status = 'failed';
      waiter.lease.error = reason;
      waiter.lease.releasedAt = Date.now();
      await this.leases.save(waiter.lease);
      waiter.reject(new ConflictException(reason));
    }));
  }
}

function serializeError(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response) return response as Record<string, unknown>;
  }
  const details = (error as Error & { details?: unknown } | null)?.details;
  return typeof details === 'object' && details
    ? { message: error instanceof Error ? error.message : String(error), ...(details as Record<string, unknown>) }
    : { message: error instanceof Error ? error.message : String(error) };
}

function isFailClosed(error: Record<string, unknown>) {
  return ['PROVIDER_RELEASE_FAILED', 'COMFYUI_TAKEOVER_REQUIRED', 'COMFYUI_TAKEOVER_FAILED'].includes(String(error.code || ''));
}
