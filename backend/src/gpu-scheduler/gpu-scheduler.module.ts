import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalComputeLease } from './gpu-resource-lease.entity';
import { LocalComputeSchedulerController } from './gpu-scheduler.controller';
import { LocalComputeSchedulerService } from './gpu-scheduler.service';
import { SettingsModule } from '../settings/settings.module';
import { SystemResourcesModule } from '../system-resources/system-resources.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([LocalComputeLease]), SettingsModule, SystemResourcesModule],
  controllers: [LocalComputeSchedulerController],
  providers: [LocalComputeSchedulerService],
  exports: [LocalComputeSchedulerService],
})
export class LocalComputeSchedulerModule {}

/** @deprecated Compatibility alias for existing imports. */
export { LocalComputeSchedulerModule as GpuSchedulerModule };
