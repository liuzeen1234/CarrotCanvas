import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsModule } from '../assets/assets.module';
import { CanvasModule } from '../canvas/canvas.module';
import { RunsModule } from '../runs/runs.module';
import { SpeechEvaluationItem } from './speech-evaluation.entity';
import { SpeechEvaluatorController } from './speech-evaluator.controller';
import { SpeechEvaluatorService } from './speech-evaluator.service';
import { SpeechToolRunnerService } from './speech-tool-runner.service';

@Module({ imports: [TypeOrmModule.forFeature([SpeechEvaluationItem]), AssetsModule, CanvasModule, RunsModule], controllers: [SpeechEvaluatorController], providers: [SpeechEvaluatorService, SpeechToolRunnerService] })
export class SpeechEvaluatorModule {}
