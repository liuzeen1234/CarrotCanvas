import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { Workflow } from '../workflows/workflow.entity';
import { Setting } from '../settings/setting.entity';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from '../canvas/canvas.entity';
import { Asset } from '../assets/asset.entity';
import { GenerationCandidateGroup, GenerationRun, GenerationRunHandoff } from '../runs/generation-run.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(__dirname, '..', '..', 'data', 'carrot-canvas.sqlite'),
      entities: [Workflow, Setting, CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Asset, GenerationRun, GenerationRunHandoff, GenerationCandidateGroup],
      synchronize: true,
    }),
  ],
})
export class DatabaseModule {}
