import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { SettingsModule } from './settings/settings.module';
import { ComfyuiModule } from './comfyui/comfyui.module';
import { CanvasModule } from './canvas/canvas.module';
import { AssetsModule } from './assets/assets.module';
import { Codex2ApiModule } from './codex2api/codex2api.module';
import { RunsModule } from './runs/runs.module';
import { SystemResourcesModule } from './system-resources/system-resources.module';
import { LocalComputeSchedulerModule } from './gpu-scheduler/gpu-scheduler.module';
import { TtsModule } from './tts/tts.module';
import { SpeechEvaluatorModule } from './speech-evaluator/speech-evaluator.module';

@Module({
  imports: [
    DatabaseModule,
    WorkflowsModule,
    SettingsModule,
    ComfyuiModule,
    CanvasModule,
    AssetsModule,
    Codex2ApiModule,
    RunsModule,
    SystemResourcesModule,
    LocalComputeSchedulerModule,
    TtsModule,
    SpeechEvaluatorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
