import { Controller, Get } from '@nestjs/common';
import { SystemResourcesService } from './system-resources.service';

@Controller('system')
export class SystemResourcesController {
  constructor(private readonly resources: SystemResourcesService) {}

  @Get('resources')
  resourcesSnapshot() {
    return this.resources.snapshot();
  }
}
