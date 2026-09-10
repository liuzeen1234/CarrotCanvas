import { Injectable, OnModuleInit } from '@nestjs/common';
import { LocalComputeSchedulerService } from '../gpu-scheduler/gpu-scheduler.service';
import { TTS_PROVIDERS, TtsClientService } from './tts-client.service';
import { TtsProcessManagerService } from './tts-process-manager.service';
import { ComfyUIProcessManagerService } from '../comfyui/comfyui-process-manager.service';

@Injectable()
export class TtsGpuProviderService implements OnModuleInit {
  constructor(private readonly scheduler: LocalComputeSchedulerService, private readonly client: TtsClientService, private readonly processes: TtsProcessManagerService, private readonly comfyProcesses: ComfyUIProcessManagerService) {}
  async onModuleInit() {
    for (const provider of TTS_PROVIDERS) {
      this.scheduler.registerProvider(provider, {
        prepare: async () => {
          await this.waitForExternalComfyAndFree();
          for (const other of TTS_PROVIDERS) if (other !== provider) await this.processes.stop(other);
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
