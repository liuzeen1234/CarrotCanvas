import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { Workflow } from '../workflows/workflow.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(__dirname, '..', '..', 'data', 'carrot-canvas.sqlite'),
      entities: [Workflow],
      synchronize: true,
    }),
  ],
})
export class DatabaseModule {}
