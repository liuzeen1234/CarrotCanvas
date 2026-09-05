import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasControlLease, CanvasDoc, CanvasOperationReceipt } from './canvas.entity';
import { CanvasService } from './canvas.service';
import { CanvasController } from './canvas.controller';
import { AssetsModule } from '../assets/assets.module';
import { ActionsController } from './actions.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CanvasDoc, CanvasControlLease, CanvasOperationReceipt]), forwardRef(() => AssetsModule)],
  controllers: [CanvasController, ActionsController],
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
