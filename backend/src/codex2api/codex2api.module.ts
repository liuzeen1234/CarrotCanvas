import { Module } from '@nestjs/common';
import { Codex2ApiController } from './codex2api.controller';
import { Codex2ApiService } from './codex2api.service';
import { SettingsModule } from '../settings/settings.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [SettingsModule, AssetsModule],
  controllers: [Codex2ApiController],
  providers: [Codex2ApiService],
})
export class Codex2ApiModule {}
