import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from './asset.entity';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { CanvasModule } from '../canvas/canvas.module';

@Module({
  imports: [TypeOrmModule.forFeature([Asset]), forwardRef(() => CanvasModule)],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
