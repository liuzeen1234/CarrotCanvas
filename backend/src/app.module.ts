import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { SettingsModule } from './settings/settings.module';
import { ComfyuiModule } from './comfyui/comfyui.module';
import { CanvasModule } from './canvas/canvas.module';
import { AssetsModule } from './assets/assets.module';

@Module({
  imports: [
    DatabaseModule,
    WorkflowsModule,
    SettingsModule,
    ComfyuiModule,
    CanvasModule,
    AssetsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
