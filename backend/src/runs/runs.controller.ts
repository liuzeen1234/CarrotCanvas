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
  @Get(':id') async get(@Param('id') id: string) { const run = await this.runs.get(id); return { ...run, capabilities: this.runs.capabilities(run), handoffs: await this.runs.handoffHistory(id) }; }
  @Get(':id/wait') async wait(@Param('id') id: string) { const run = await this.runs.get(id); return { ...run, capabilities: this.runs.capabilities(run), handoffs: await this.runs.handoffHistory(id) }; }
  @Get(':id/lineage') lineage(@Param('id') id: string) { return this.runs.lineage(id); }
  @Post(':id/retry') retry(@Param('id') id: string, @Body() body: any) { return this.runs.retry(id, body.idempotencyKey); }
  @Post(':id/handoff') async handoff(@Param('id') id: string, @Body() body: any) {
    const run = await this.runs.get(id); if (!run.canvasId) return this.runs.recordRelease(id, body);
    await this.canvas.assertWriteAccess(run.canvasId, body); await this.canvas.assertLeaseHolder(run.canvasId, body);
    const record = await this.runs.recordRelease(id, { actorType: body.actorType, actorId: body.actorId, leaseEpoch: body.leaseEpoch, summary: body.summary });
    try { await this.canvas.attachHandoff(run.canvasId, record.id, body); const released = await this.canvas.release(run.canvasId, body); return { run: await this.runs.get(id), handoff: record, released }; }
    catch (error) { await this.runs.markReleaseFailed(record.id); throw error; }
  }
  @Post(':id/adopt') async adopt(@Param('id') id: string, @Body() body: any) {
    const run = await this.runs.get(id); if (!run.canvasId) return this.runs.adopt(id, body);
    await this.canvas.assertWriteAccess(run.canvasId, body); await this.canvas.assertLeaseHolder(run.canvasId, body);
    return this.runs.adopt(id, { actorType: body.actorType, actorId: body.actorId, leaseEpoch: body.leaseEpoch });
  }
  @Post(':id/cancel') cancel(@Param('id') id: string) { return this.runs.cancel(id); }
}
