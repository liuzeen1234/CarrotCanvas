import { Body, Controller, Get, Put } from '@nestjs/common';
import { LocalComputeSchedulerService, ThermalPolicyInput } from './gpu-scheduler.service';

@Controller(['local-compute-scheduler', 'gpu-scheduler'])
export class LocalComputeSchedulerController {
  constructor(private readonly scheduler: LocalComputeSchedulerService) {}

  @Get('status')
  status() { return this.scheduler.getState(); }

  @Get('thermal-policy')
  thermalPolicy() { return this.scheduler.getThermalPolicy(); }

  @Put('thermal-policy')
  updateThermalPolicy(@Body() body: ThermalPolicyInput) { return this.scheduler.updateThermalPolicy(body); }
}
