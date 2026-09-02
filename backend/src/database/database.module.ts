import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { Workflow } from '../workflows/workflow.entity';
import { Setting } from '../settings/setting.entity';
import { CanvasDoc } from '../canvas/canvas.entity';
import { Asset } from '../assets/asset.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(__dirname, '..', '..', 'data', 'carrot-canvas.sqlite'),
      entities: [Workflow, Setting, CanvasDoc, Asset],
      synchronize: true,
    }),
  ],
})
export class DatabaseModule {}
