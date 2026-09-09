import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GpuResourceLease } from './gpu-resource-lease.entity';
import { GpuSchedulerController } from './gpu-scheduler.controller';
import { GpuSchedulerService } from './gpu-scheduler.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([GpuResourceLease])],
  controllers: [GpuSchedulerController],
  providers: [GpuSchedulerService],
  exports: [GpuSchedulerService],
})
export class GpuSchedulerModule {}
