import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CanvasModule } from '../canvas/canvas.module';
import { AssetsModule } from '../assets/assets.module';
import { ComfyUIClientService } from './comfyui-client';
import { ComfyUIGraphConverter } from './comfyui-graph-converter';
import { ComfyUIRunnerService } from './comfyui-runner.service';
import { ComfyUISchemaService } from './comfyui-schema.service';
import { ComfyUIAssetCaptureService } from './comfyui-capture.service';
import { ComfyUIController } from './comfyui.controller';
import { RunsModule } from '../runs/runs.module';

@Module({
  imports: [SettingsModule, WorkflowsModule, CanvasModule, AssetsModule, RunsModule],
  controllers: [ComfyUIController],
  providers: [
    ComfyUIClientService,
    ComfyUIGraphConverter,
    ComfyUIRunnerService,
    ComfyUISchemaService,
    ComfyUIAssetCaptureService,
  ],
  exports: [ComfyUIClientService, ComfyUIRunnerService],
})
export class ComfyuiModule {}
