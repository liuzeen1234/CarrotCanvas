import { Controller, Get } from '@nestjs/common';
import { CanvasService } from './canvas.service';

@Controller('actions')
export class ActionsController {
  constructor(private readonly canvas: CanvasService) {}
  @Get()
  list() { return this.canvas.actions(); }
}
