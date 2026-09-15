import { BadRequestException, ConflictException, HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LocalComputeLease, LocalComputeProvider } from './gpu-resource-lease.entity';
import { SettingsService } from '../settings/settings.service';
import { SystemResourcesService } from '../system-resources/system-resources.service';

const THERMAL_POLICY_KEY = 'local-compute-thermal-policy';
const DEFAULT_THERMAL_POLICY: ThermalPolicy = { enabled: true, thresholdC: 50, retryIntervalMs: 60_000, maxWaitRounds: 10 };

export interface ThermalPolicy {
  enabled: boolean;
  thresholdC: number;
  retryIntervalMs: number;
  maxWaitRounds: number;
}

export type ThermalPolicyInput = Partial<ThermalPolicy>;

interface ThermalState {
  status: 'idle' | 'checking' | 'cooling' | 'timed_out';
  runId: string | null;
  temperatureC: number | null;
  sampledAt: number | null;
  waitedRounds: number;
  nextCheckAt: number | null;
  error: string | null;
}

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
  private thermalPolicy: ThermalPolicy = { ...DEFAULT_THERMAL_POLICY };
  private thermalState: ThermalState = this.idleThermalState();

  constructor(
    @InjectRepository(LocalComputeLease) private readonly leases: Repository<LocalComputeLease>,
    private readonly resources: SystemResourcesService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit() {
    await this.loadThermalPolicy();
    await this.migrateLegacyGpuLeases();
    await this.leases.createQueryBuilder().update().set({
      status: 'abandoned',
      releasedAt: Date.now(),
      error: { code: 'SCHEDULER_RESTARTED', message: '后端重启后资源所有权需要重新核实' },
    }).where('status IN (:...statuses)', { statuses: ['waiting', 'cooling', 'preparing', 'active', 'releasing'] }).execute();
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
      thermal: { policy: this.thermalPolicy, state: this.thermalState },
    };
  }

  getThermalPolicy() { return { ...this.thermalPolicy }; }

  async updateThermalPolicy(input: ThermalPolicyInput) {
    const policy = validateThermalPolicy({ ...this.thermalPolicy, ...input });
    await this.settings.set(THERMAL_POLICY_KEY, JSON.stringify(policy));
    this.thermalPolicy = policy;
    return this.getThermalPolicy();
  }

  clearBlock() { this.blocked = null; void this.advance(); }

  private async advance() {
    if (this.advancing || this.current || !this.queue.length) return;
    this.advancing = true;
    const waiter = this.queue.shift()!;
    let preparingProvider = false;
    try {
      waiter.lease.status = 'preparing';
      await this.leases.save(waiter.lease);
      if (this.residentProvider && this.residentProvider !== waiter.lease.provider) {
        await this.providers.get(this.residentProvider)?.release();
        this.residentProvider = null;
      }
      await this.waitForSafeTemperature(waiter);
      preparingProvider = true;
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
      if (preparingProvider) this.residentProvider = null;
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

  private async waitForSafeTemperature(waiter: Waiter) {
    const policy = { ...this.thermalPolicy };
    if (!policy.enabled || waiter.lease.runId.startsWith('startup:')) {
      this.thermalState = this.idleThermalState();
      return;
    }
    waiter.lease.status = 'cooling';
    await this.leases.save(waiter.lease);
    for (let waitedRounds = 0; waitedRounds <= policy.maxWaitRounds; waitedRounds += 1) {
      this.thermalState = { status: 'checking', runId: waiter.lease.runId, temperatureC: null,
        sampledAt: null, waitedRounds, nextCheckAt: null, error: null };
      const sample = await this.sampleCuda0Temperature();
      if (sample.temperatureC != null && sample.temperatureC <= policy.thresholdC) {
        this.thermalState = { status: 'idle', runId: null, temperatureC: sample.temperatureC,
          sampledAt: sample.sampledAt, waitedRounds, nextCheckAt: null, error: null };
        return;
      }
      if (waitedRounds === policy.maxWaitRounds) {
        const code = sample.temperatureC == null ? 'GPU_TEMPERATURE_UNAVAILABLE' : 'GPU_COOLDOWN_TIMEOUT';
        const message = sample.temperatureC == null
          ? `连续 ${policy.maxWaitRounds} 轮无法读取 GPU 0 温度，已中止本批本机重型计算任务`
          : `GPU 0 温度 ${sample.temperatureC}°C，等待 ${policy.maxWaitRounds} 轮后仍高于 ${policy.thresholdC}°C，已中止本批本机重型计算任务`;
        const reason = { code, message, deviceKey: 'cuda:0', thresholdC: policy.thresholdC,
          lastTemperatureC: sample.temperatureC, waitedRounds, waitedMs: waitedRounds * policy.retryIntervalMs,
          telemetryError: sample.error };
        this.thermalState = { status: 'timed_out', runId: waiter.lease.runId, temperatureC: sample.temperatureC,
          sampledAt: sample.sampledAt, waitedRounds, nextCheckAt: null, error: message };
        await this.rejectWaitingBatch(reason);
        throw new ConflictException(reason);
      }
      const nextCheckAt = Date.now() + policy.retryIntervalMs;
      this.thermalState = { status: 'cooling', runId: waiter.lease.runId, temperatureC: sample.temperatureC,
        sampledAt: sample.sampledAt, waitedRounds, nextCheckAt, error: sample.error };
      await this.sleep(policy.retryIntervalMs);
    }
  }

  private async sampleCuda0Temperature() {
    try {
      const snapshot = await this.resources.snapshot();
      const device = snapshot.gpu.devices.find((item) => item.index === 0);
      return { temperatureC: device?.temperatureC ?? null, sampledAt: snapshot.sampledAt,
        error: device?.temperatureC == null ? snapshot.gpu.error || 'GPU 0 温度不可用' : null };
    } catch (error) {
      return { temperatureC: null, sampledAt: Date.now(), error: (error as Error).message };
    }
  }

  private async rejectWaitingBatch(reason: Record<string, unknown>) {
    const pending = this.queue.splice(0);
    await Promise.all(pending.map(async (waiter) => {
      waiter.lease.status = 'failed';
      waiter.lease.error = reason;
      waiter.lease.releasedAt = Date.now();
      await this.leases.save(waiter.lease);
      waiter.reject(new ConflictException(reason));
    }));
  }

  private sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  private idleThermalState(): ThermalState {
    return { status: 'idle', runId: null, temperatureC: null, sampledAt: null,
      waitedRounds: 0, nextCheckAt: null, error: null };
  }

  private async loadThermalPolicy() {
    const row = await this.settings.get(THERMAL_POLICY_KEY);
    if (!row?.value) return;
    try { this.thermalPolicy = validateThermalPolicy(JSON.parse(row.value)); }
    catch (error) { this.logger.warn(`忽略无效温控配置：${(error as Error).message}`); }
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
  return ['PROVIDER_RELEASE_FAILED', 'PROVIDER_STATE_UNCONFIRMED', 'COMFYUI_TAKEOVER_REQUIRED', 'COMFYUI_TAKEOVER_FAILED'].includes(String(error.code || ''));
}

function validateThermalPolicy(input: ThermalPolicyInput): ThermalPolicy {
  const policy = { ...DEFAULT_THERMAL_POLICY, ...input };
  if (typeof policy.enabled !== 'boolean') throw new BadRequestException('enabled 必须是布尔值');
  if (!Number.isFinite(policy.thresholdC) || policy.thresholdC < 30 || policy.thresholdC > 90) throw new BadRequestException('thresholdC 必须在 30–90°C');
  if (!Number.isInteger(policy.retryIntervalMs) || policy.retryIntervalMs < 1_000 || policy.retryIntervalMs > 600_000) throw new BadRequestException('retryIntervalMs 必须在 1000–600000 毫秒');
  if (!Number.isInteger(policy.maxWaitRounds) || policy.maxWaitRounds < 1 || policy.maxWaitRounds > 60) throw new BadRequestException('maxWaitRounds 必须在 1–60');
  return policy;
}
