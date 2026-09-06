import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from './generation-run.entity';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { CanvasModule } from '../canvas/canvas.module';

@Module({ imports: [TypeOrmModule.forFeature([GenerationRun, GenerationRunHandoff, GenerationCandidateGroup, Asset]), CanvasModule], controllers: [RunsController], providers: [RunsService], exports: [RunsService] })
export class RunsModule {}
