import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from './generation-run.entity';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { CanvasModule } from '../canvas/canvas.module';
import { AssetsModule } from '../assets/assets.module';
import { RunRecoveryService } from './run-recovery.service';

@Module({ imports: [TypeOrmModule.forFeature([GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Asset]), CanvasModule, AssetsModule], controllers: [RunsController], providers: [RunsService, RunRecoveryService], exports: [RunsService] })
export class RunsModule {}
