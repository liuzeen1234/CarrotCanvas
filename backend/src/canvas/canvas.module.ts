import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasAssetGcJob, CanvasCheckpoint, CanvasControlLease, CanvasDoc, CanvasOperationLog, CanvasOperationReceipt } from './canvas.entity';
import { CanvasService } from './canvas.service';
import { CanvasController } from './canvas.controller';
import { AssetsModule } from '../assets/assets.module';
import { ActionsController } from './actions.controller';
import { Workflow } from '../workflows/workflow.entity';
import { CanvasIoService } from './canvas-io.service';
import { CanvasIoController } from './canvas-io.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CanvasDoc, CanvasControlLease, CanvasOperationReceipt, CanvasOperationLog, CanvasCheckpoint, CanvasAssetGcJob, Workflow]), forwardRef(() => AssetsModule)],
  controllers: [CanvasController, CanvasIoController, ActionsController],
  providers: [CanvasService, CanvasIoService],
  exports: [CanvasService],
})
export class CanvasModule {}
