import { Injectable, OnModuleInit } from '@nestjs/common';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { ComfyUIClientService } from './comfyui-client';
import { ComfyUIProcessManagerService } from './comfyui-process-manager.service';

@Injectable()
export class ComfyUIGpuProviderService implements OnModuleInit {
  constructor(private readonly scheduler: LocalComputeSchedulerService, private readonly client: ComfyUIClientService, private readonly processes: ComfyUIProcessManagerService) {}

  onModuleInit() {
    this.scheduler.registerProvider('comfyui', {
      prepare: async () => { await this.processes.ensureManagedRunning(); },
      release: async () => { await this.release(); },
    });
  }

  private async release() {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const queue = await this.client.getQueue();
      const running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0;
      const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0;
      if (!running && !pending) break;
      await delay(1_000);
    }
    const queue = await this.client.getQueue();
    if ((queue.queue_running as unknown[])?.length || (queue.queue_pending as unknown[])?.length) {
      throw new Error('ComfyUI 队列在 120 秒内未空闲，拒绝切换本机重型计算 Provider');
    }
    await this.processes.releaseManaged();
  }
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
