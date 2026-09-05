import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from './canvas.entity';
import { CanvasService } from './canvas.service';
import { CanvasController } from './canvas.controller';
import { AssetsModule } from '../assets/assets.module';
import { ActionsController } from './actions.controller';
import { Workflow } from '../workflows/workflow.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow]), forwardRef(() => AssetsModule)],
  controllers: [CanvasController, ActionsController],
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
