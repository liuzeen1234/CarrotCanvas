import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RunsService } from './runs.service';
import { CanvasService } from '../canvas/canvas.service';

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService, private readonly canvas: CanvasService) {}
  @Get() list(@Query() query: Record<string, string>) { return this.runs.list(query); }
  @Get('candidates/group') group(@Query('canvasId') canvasId: string, @Query('nodeId') nodeId?: string, @Query('shotId') shotId?: string) { return this.runs.group(canvasId, nodeId, shotId); }
  @Patch('candidates/group') async choose(@Body() body: any) { await this.canvas.assertWriteAccess(body.canvasId, body); return this.runs.choose(body.canvasId, body.nodeId ?? null, body.shotId ?? null, body.assetId, !!body.approve, body.actorType); }
  @Patch('candidates/text') async chooseText(@Body() body: any) { await this.canvas.assertWriteAccess(body.canvasId, body); return this.runs.chooseText(body.canvasId, body.nodeId, body.runId); }
  @Get(':id') get(@Param('id') id: string) { return this.runs.get(id); }
  @Get(':id/wait') wait(@Param('id') id: string) { return this.runs.get(id); }
  @Get(':id/lineage') lineage(@Param('id') id: string) { return this.runs.lineage(id); }
  @Post(':id/retry') retry(@Param('id') id: string, @Body() body: any) { return this.runs.retry(id, body.idempotencyKey); }
  @Post(':id/adopt') getForAdopt(@Param('id') id: string) { return this.runs.get(id); }
  @Post(':id/cancel') cancel(@Param('id') id: string) { return this.runs.cancel(id); }
}
