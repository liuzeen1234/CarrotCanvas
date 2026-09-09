import { ConflictException, HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LocalComputeLease, LocalComputeProvider } from './gpu-resource-lease.entity';

export interface LocalComputeProviderLifecycle {
  prepare(): Promise<void>;
  release(): Promise<void>;
  retainAfterLease?: boolean;
}

export interface LocalComputeLeaseHandle {
  lease: LocalComputeLease;
  release(error?: unknown): Promise<void>;
}

type Waiter = {
  lease: LocalComputeLease;
  resolve: (handle: LocalComputeLeaseHandle) => void;
  reject: (error: unknown) => void;
};

@Injectable()
export class LocalComputeSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(LocalComputeSchedulerService.name);
  private readonly providers = new Map<LocalComputeProvider, LocalComputeProviderLifecycle>();
  private readonly queue: Waiter[] = [];
  private current: LocalComputeLease | null = null;
  private residentProvider: LocalComputeProvider | null = null;
  private advancing = false;
  private blocked: Record<string, unknown> | null = null;

  constructor(@InjectRepository(LocalComputeLease) private readonly leases: Repository<LocalComputeLease>) {}

  async onModuleInit() {
    await this.migrateLegacyGpuLeases();
    await this.leases.createQueryBuilder().update().set({
      status: 'abandoned',
      releasedAt: Date.now(),
      error: { code: 'SCHEDULER_RESTARTED', message: '后端重启后资源所有权需要重新核实' },
    }).where('status IN (:...statuses)', { statuses: ['waiting', 'preparing', 'active', 'releasing'] }).execute();
  }

  registerProvider(name: LocalComputeProvider, lifecycle: LocalComputeProviderLifecycle) {
    this.providers.set(name, lifecycle);
  }

  async acquire(provider: LocalComputeProvider, runId: string): Promise<LocalComputeLeaseHandle> {
    if (this.blocked) throw new ConflictException(this.blocked);
    const lease = await this.leases.save(this.leases.create({
      deviceKey: 'cuda:0', runId, provider, status: 'waiting', queuedAt: Date.now(),
      acquiredAt: null, releasedAt: null, error: null,
    }));
    return new Promise<LocalComputeLeaseHandle>((resolve, reject) => {
      this.queue.push({ lease, resolve, reject });
      void this.advance();
    });
  }

  getState() {
    return {
      resourceKey: 'local-heavy-compute:0',
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
          let releaseError = error;
          const lifecycle = this.providers.get(active.provider);
          if (lifecycle?.retainAfterLease === false) {
            active.status = 'releasing';
            await this.leases.save(active);
            try { await lifecycle.release(); this.residentProvider = null; }
            catch (cleanupError) { releaseError ??= cleanupError; }
          }
          active.status = releaseError ? 'failed' : 'released';
          active.error = releaseError ? serializeError(releaseError) : null;
          active.releasedAt = Date.now();
          await this.leases.save(active);
          this.current = null;
          if (releaseError && isFailClosed(serializeError(releaseError))) await this.failClosed(serializeError(releaseError));
          else void this.advance();
        },
      });
    } catch (error) {
      waiter.lease.status = 'failed';
      waiter.lease.error = serializeError(error);
      waiter.lease.releasedAt = Date.now();
      await this.leases.save(waiter.lease);
      this.logger.error(`本机重型计算 Provider ${waiter.lease.provider} 准备失败：${(error as Error).message}`);
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

  private async migrateLegacyGpuLeases() {
    const rows = await this.leases.query("SELECT name FROM sqlite_master WHERE type='table' AND name='gpu_resource_leases'") as unknown[];
    if (!rows.length) return;
    await this.leases.query(`INSERT OR IGNORE INTO local_compute_leases
      (id, device_key, run_id, provider, status, queued_at, acquired_at, released_at, error, created_at, updated_at)
      SELECT id, device_key, run_id, provider, status, queued_at, acquired_at, released_at, error, created_at, updated_at
      FROM gpu_resource_leases`);
  }
}

/** @deprecated Use LocalComputeSchedulerService. */
export { LocalComputeSchedulerService as GpuSchedulerService };
export type GpuProviderLifecycle = LocalComputeProviderLifecycle;
export type GpuLeaseHandle = LocalComputeLeaseHandle;

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
