import { Module } from '@nestjs/common';
import { SystemResourcesController } from './system-resources.controller';
import { SystemResourcesService } from './system-resources.service';

@Module({ controllers: [SystemResourcesController], providers: [SystemResourcesService] })
export class SystemResourcesModule {}
