import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { CanvasModule } from '../canvas/canvas.module';
import { RunsModule } from '../runs/runs.module';
import { TtsClientService } from './tts-client.service';
import { TtsController } from './tts.controller';
import { TtsGpuProviderService } from './tts-gpu-provider.service';
import { TtsProcessManagerService } from './tts-process-manager.service';
import { ComfyuiModule } from '../comfyui/comfyui.module';

@Module({
  imports: [AssetsModule, CanvasModule, RunsModule, ComfyuiModule],
  controllers: [TtsController],
  providers: [TtsClientService, TtsGpuProviderService, TtsProcessManagerService],
})
export class TtsModule {}
