import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CanvasService } from '../canvas/canvas.service';
import { RunsService } from '../runs/runs.service';
import { EvaluationTarget, SpeechEvaluatorService } from './speech-evaluator.service';

interface SubmitBody { canvasId: string; nodeId?: string; targets: EvaluationTarget[]; leaseToken: string; leaseEpoch: number; expectedRevision: number; idempotencyKey?: string; actorType?: 'human' | 'agent'; actorId?: string }

@Controller('speech-evaluator')
export class SpeechEvaluatorController {
  constructor(private readonly evaluator: SpeechEvaluatorService, private readonly runs: RunsService, private readonly canvas: CanvasService) {}

  @Post('runs')
  async submit(@Body() body: SubmitBody) {
    if (!body.canvasId || !Array.isArray(body.targets) || !body.targets.length) throw new BadRequestException('缺少画布或目标语音');
    await this.canvas.assertWriteAccess(body.canvasId, body);
    const inputAssetIds = [...new Set(body.targets.flatMap((target) => [target.assetId, ...(target.referenceAssetId ? [target.referenceAssetId] : [])]))];
    const begun = await this.runs.begin({ provider: 'speech-evaluator', canvasId: body.canvasId, nodeId: body.nodeId ?? null,
      inputSnapshot: { targets: body.targets, executionPolicy: 'tool-major-serial-v1' }, inputAssetIds,
      actorType: body.actorType ?? 'human', actorId: body.actorId ?? 'web', idempotencyKey: body.idempotencyKey ?? null,
      capabilityId: 'speech-evaluator', capabilityVersion: 'builtin-acoustics-v1' });
    if (!begun.replay) await this.evaluator.create(begun.run.id, body.canvasId, body.targets);
    if (begun.replay && ['succeeded', 'failed', 'cancelled'].includes(begun.run.status)) return { run: begun.run, items: await this.evaluator.list(begun.run.id), replay: true };
    this.evaluator.start(begun.run.id);
    return { run: begun.run, items: await this.evaluator.list(begun.run.id), replay: begun.replay };
  }

  @Get('runs/:id') async get(@Param('id') id: string) { return { run: await this.runs.get(id), items: await this.evaluator.list(id) }; }
  @Post('runs/:id/cancel') cancel(@Param('id') id: string) { return this.evaluator.cancel(id); }
}
