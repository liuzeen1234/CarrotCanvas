import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { ComfyUIClientService } from './comfyui-client';
import { ComfyUIGraphConverter } from './comfyui-graph-converter';
import { ComfyUIRunnerService } from './comfyui-runner.service';
import { ComfyUISchemaService } from './comfyui-schema.service';
import { ComfyUIController } from './comfyui.controller';

@Module({
  imports: [SettingsModule, WorkflowsModule],
  controllers: [ComfyUIController],
  providers: [
    ComfyUIClientService,
    ComfyUIGraphConverter,
    ComfyUIRunnerService,
    ComfyUISchemaService,
  ],
  exports: [ComfyUIClientService, ComfyUIRunnerService],
})
export class ComfyuiModule {}
