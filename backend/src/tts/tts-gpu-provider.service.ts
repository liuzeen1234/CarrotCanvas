import { Injectable, OnModuleInit } from '@nestjs/common';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { TtsClientService } from './tts-client.service';
import { TtsProcessManagerService } from './tts-process-manager.service';
import { ComfyUIProcessManagerService } from '../comfyui/comfyui-process-manager.service';

@Injectable()
export class TtsGpuProviderService implements OnModuleInit {
  constructor(private readonly scheduler: LocalComputeSchedulerService, private readonly client: TtsClientService, private readonly processes: TtsProcessManagerService, private readonly comfyProcesses: ComfyUIProcessManagerService) {}
  async onModuleInit() {
    for (const provider of ['cosyvoice3', 'indextts2'] as const) {
      this.scheduler.registerProvider(provider, {
        prepare: async () => {
          await this.waitForExternalComfyAndFree();
          const other = provider === 'cosyvoice3' ? 'indextts2' : 'cosyvoice3';
          await this.processes.stop(other);
          await this.processes.ensureRunning(provider);
          await this.client.prepare(provider);
        },
        release: () => this.processes.stop(provider).then(() => undefined),
      });
    }
  }

  private async waitForExternalComfyAndFree() {
    await this.comfyProcesses.releaseBeforeOtherProvider();
  }
}
