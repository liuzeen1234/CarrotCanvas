import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { SettingsService } from '../settings/settings.service';
import { ComfyUIProcessManagerService } from './comfyui-process-manager.service';

/** Best-effort startup warmup for installations explicitly entrusted to CarrotCanvas. */
@Injectable()
export class ComfyUIStartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ComfyUIStartupService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly processes: ComfyUIProcessManagerService,
    private readonly scheduler: LocalComputeSchedulerService,
  ) {}

  onApplicationBootstrap() {
    // Do not delay the CarrotCanvas health endpoint while ComfyUI and custom
    // nodes initialise. The scheduler still serialises this warmup with runs.
    setTimeout(() => void this.warmup().catch((error) => {
      this.logger.warn(`ComfyUI 启动检查失败：${(error as Error).message}`);
    }), 0);
  }

  async warmup() {
    const alwaysManaged = await this.settings.get('comfyui-always-managed');
    const launch = await this.settings.get('comfyui-managed-launch');
    if (alwaysManaged?.value !== 'true' || !launch?.value) {
      this.logger.log('ComfyUI 启动检查完成：未启用托管自启动');
      return { started: false, reason: 'not-configured' };
    }

    const inspection = await this.processes.inspect();
    if (inspection.portOwner && await this.processes.isManagedRunning(inspection)) {
      const lease = await this.scheduler.acquire('comfyui', `startup:${randomUUID()}`);
      await lease.release();
      this.logger.log('ComfyUI 托管服务已在线并纳入调度器');
      return { started: false, reason: 'already-managed' };
    }
    if (inspection.portOwner || inspection.desktopProcesses.length) {
      this.logger.log('ComfyUI 启动检查完成：检测到现有服务或 Desktop，不重复启动');
      return { started: false, reason: 'already-present', inspection };
    }

    try {
      const lease = await this.scheduler.acquire('comfyui', `startup:${randomUUID()}`);
      await lease.release();
      this.logger.log('ComfyUI 托管服务已启动并通过健康检查');
      return { started: true };
    } catch (error) {
      // Startup warmup must not take the CarrotCanvas API down. A later run can
      // surface the same structured scheduler/process error to the caller.
      this.logger.warn(`ComfyUI 托管服务启动失败：${(error as Error).message}`);
      return { started: false, reason: 'failed', error };
    }
  }
}
