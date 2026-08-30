import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workflow } from './workflow.entity';
import { WorkflowsService } from './workflows.service';
import { WorkflowsController } from './workflows.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Workflow])],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
