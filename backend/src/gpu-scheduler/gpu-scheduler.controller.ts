import { Controller, Get } from '@nestjs/common';
import { LocalComputeSchedulerService } from './gpu-scheduler.service';

@Controller(['local-compute-scheduler', 'gpu-scheduler'])
export class LocalComputeSchedulerController {
  constructor(private readonly scheduler: LocalComputeSchedulerService) {}

  @Get('status')
  status() { return this.scheduler.getState(); }
}
