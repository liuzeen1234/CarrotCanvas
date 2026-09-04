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

@Module({
  imports: [
    DatabaseModule,
    WorkflowsModule,
    SettingsModule,
    ComfyuiModule,
    CanvasModule,
    AssetsModule,
    Codex2ApiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
