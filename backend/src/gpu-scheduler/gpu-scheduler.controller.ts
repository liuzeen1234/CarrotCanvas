import { Controller, Get } from '@nestjs/common';
import { GpuSchedulerService } from './gpu-scheduler.service';

@Controller('gpu-scheduler')
export class GpuSchedulerController {
  constructor(private readonly scheduler: GpuSchedulerService) {}

  @Get('status')
  status() { return this.scheduler.getState(); }
}
