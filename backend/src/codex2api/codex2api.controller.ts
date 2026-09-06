import {
  BadGatewayException, Body, Controller, Get, Post, Put, Query, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Codex2ApiService, UploadFile } from './codex2api.service';
import { CanvasService } from '../canvas/canvas.service';
import { RunsService } from '../runs/runs.service';

@Controller('codex2api')
export class Codex2ApiController {
  constructor(private readonly service: Codex2ApiService, private readonly canvas: CanvasService, private readonly runs: RunsService) {}

  @Get('config')
  getConfig() { return this.service.getPublicConfig(); }

  @Put('config')
  updateConfig(@Body() body: { baseUrl?: string; apiKey?: string | null; clearApiKey?: boolean }) {
    return this.service.updateConfig(body || {});
  }

  @Get('health')
  async health() {
    const response = await this.service.request('/health', {}, 10_000);
    return this.service.readJsonResponse(response);
  }

  @Get('models')
  async models() {
    const response = await this.service.request('/v1/models', {}, 15_000);
    return this.service.readJsonResponse(response);
  }

  @Get('image')
  async image(@Query('url') url: string, @Query('download') download: string | undefined, @Res() res: any) {
    const upstream = await this.service.fetchImage(url);
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', download === '1' ? 'attachment; filename="codex2api-image.png"' : 'inline');
    const reader = upstream.body?.getReader();
    if (!reader) return res.end();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally { res.end(); }
  }

  @Post('chat/completions')
  async chat(@Body() body: any, @Res() res: any) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, idempotencyKey, actorType, actorId, shotId, parentRunId, carrotOutputMode, ...upstreamBody } = body || {};
    const structuredPromptMode = carrotOutputMode === 'image-prompts' || carrotOutputMode === 'video-prompts';
    if (structuredPromptMode) {
      upstreamBody.stream = false;
      upstreamBody.messages = [{ role: 'system', content: carrotOutputMode === 'video-prompts' ? VIDEO_PROMPT_SYSTEM : IMAGE_PROMPT_SYSTEM }, ...(Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [])];
    }
    if (canvasId) await this.canvas.assertWriteAccess(canvasId, { leaseToken, leaseEpoch, expectedRevision });
    const begun = await this.runs.begin({ provider: 'codex2api', canvasId: canvasId || null, nodeId: nodeId || null, shotId: shotId || null, parentRunId: parentRunId || null, capabilityId: 'text-generation', capabilityVersion: String(upstreamBody.model || 'default'), inputSnapshot: { ...upstreamBody, carrotOutputMode: carrotOutputMode || 'text' }, actorType: actorType || 'human', actorId: actorId || 'web', idempotencyKey: idempotencyKey || null });
    if (begun.replay) return res.status(200).json({ runId: begun.run.id, replay: true, run: begun.run });
    await this.runs.patch(begun.run.id, { status: 'running', startedAt: Date.now() });
    let upstream: Response;
    try { upstream = await this.service.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    }, upstreamBody?.stream ? 300_000 : 120_000); } catch (error) { await this.runs.finish(begun.run.id, 'failed', [], { message: (error as Error).message }); throw error; }
    if (!upstream.ok) {
      const payload = await this.service.readJsonResponse(upstream);
      await this.runs.finish(begun.run.id, 'failed', [], payload);
      return res.status(upstream.status).json(payload);
    }
    if (upstreamBody?.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      const reader = upstream.body?.getReader();
      if (!reader) return res.end();
      let streamPayload = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamPayload += Buffer.from(value).toString('utf8');
          res.write(Buffer.from(value));
        }
      } finally {
        await this.runs.finish(begun.run.id, 'succeeded', [], null, extractStreamText(streamPayload));
        res.end();
      }
      return;
    }
    const payload = await this.service.readJsonResponse(upstream);
    const rawText = extractText(payload);
    const outputParts = structuredPromptMode ? parsePromptParts(rawText) : null;
    if (structuredPromptMode && !outputParts) {
      const error = { code: 'STRUCTURED_PROMPT_INVALID', message: '模型未返回可解析的正向与负向提示词，请重试' };
      await this.runs.finish(begun.run.id, 'failed', [], error);
      return res.status(502).json(error);
    }
    const outputText = outputParts ? combinePromptParts(outputParts) : rawText;
    if (outputParts && payload?.choices?.[0]?.message) payload.choices[0].message.content = outputText;
    await this.runs.finish(begun.run.id, 'succeeded', [], null, outputText, outputParts);
    return res.status(200).json({ ...payload, runId: begun.run.id, outputParts });
  }

  @Post('images/generations')
  async generate(@Body() body: any) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, idempotencyKey, actorType, actorId, inputAssetIds, shotId, parentRunId, ...upstreamBody } = body || {};
    if (canvasId) await this.canvas.assertWriteAccess(canvasId, { leaseToken, leaseEpoch, expectedRevision });
    const begun = await this.runs.begin({ provider: 'codex2api', canvasId: canvasId || null, nodeId: nodeId || null, shotId: shotId || null, parentRunId: parentRunId || null, capabilityId: 'image-generation', capabilityVersion: String(upstreamBody.model || 'default'), inputSnapshot: upstreamBody, inputAssetIds: Array.isArray(inputAssetIds) ? inputAssetIds : [], actorType: actorType || 'human', actorId: actorId || 'web', idempotencyKey: idempotencyKey || null });
    if (begun.replay) return { ...(begun.run as any), runId: begun.run.id, replay: true };
    try {
      await this.runs.patch(begun.run.id, { status: 'running', startedAt: Date.now() });
      const payload = await this.service.forwardJson('/v1/images/generations', upstreamBody, 600_000);
      const captured = await this.service.captureImages(payload, canvasId, nodeId);
      const ids = Array.isArray(captured?.data) ? captured.data.flatMap((item: any) => item?.assetId ? [item.assetId] : []) : [];
      await this.runs.finish(begun.run.id, 'succeeded', ids);
      return { ...captured, runId: begun.run.id };
    } catch (error) { await this.runs.finish(begun.run.id, 'failed', [], { message: (error as Error).message }); throw error; }
  }

  @Post('images/edits')
  @UseInterceptors(FilesInterceptor('image', 10, { limits: { fileSize: 15 * 1024 * 1024 } }))
  async edit(@UploadedFiles() files: UploadFile[], @Body() body: Record<string, unknown>) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, idempotencyKey, actorType, actorId, inputAssetIds, shotId, parentRunId, ...fields } = body || {};
    if (canvasId) await this.canvas.assertWriteAccess(String(canvasId), { leaseToken: String(leaseToken || ''), leaseEpoch: Number(leaseEpoch), expectedRevision: Number(expectedRevision) });
    const begun = await this.runs.begin({ provider: 'codex2api', canvasId: String(canvasId || '') || null, nodeId: String(nodeId || '') || null, shotId: String(shotId || '') || null, parentRunId: String(parentRunId || '') || null, capabilityId: 'image-edit', capabilityVersion: String(fields.model || 'default'), inputSnapshot: fields, inputAssetIds: typeof inputAssetIds === 'string' ? JSON.parse(inputAssetIds) : [], actorType: actorType === 'agent' ? 'agent' : 'human', actorId: String(actorId || 'web'), idempotencyKey: String(idempotencyKey || '') || null });
    if (begun.replay) return { ...(begun.run as any), runId: begun.run.id, replay: true };
    try {
      await this.runs.patch(begun.run.id, { status: 'running', startedAt: Date.now() });
      const payload = await this.service.forwardMultipart('/v1/images/edits', files || [], fields);
      const captured = await this.service.captureImages(payload, String(canvasId || ''), String(nodeId || ''));
      const ids = Array.isArray(captured?.data) ? captured.data.flatMap((item: any) => item?.assetId ? [item.assetId] : []) : [];
      await this.runs.finish(begun.run.id, 'succeeded', ids);
      return { ...captured, runId: begun.run.id };
    } catch (error) { await this.runs.finish(begun.run.id, 'failed', [], { message: (error as Error).message }); throw error; }
  }

  @Post('images/analyze')
  @UseInterceptors(FilesInterceptor('image', 10, { limits: { fileSize: 15 * 1024 * 1024 } }))
  async analyze(@UploadedFiles() files: UploadFile[], @Body() body: Record<string, unknown>) {
    const { canvasId, nodeId, leaseToken, leaseEpoch, expectedRevision, idempotencyKey, actorType, actorId, shotId, parentRunId, carrotOutputMode, ...fields } = body || {};
    const structuredPromptMode = carrotOutputMode === 'image-prompts' || carrotOutputMode === 'video-prompts';
    const promptIntent = carrotOutputMode === 'image-prompts' ? 'reverse-image-prompt' : undefined;
    if (structuredPromptMode) fields.prompt = `${String(fields.prompt || (carrotOutputMode === 'video-prompts' ? '请根据图片生成图生视频提示词' : '请反推可尽可能复现输入图片的图像生成提示词'))}\n\n${carrotOutputMode === 'video-prompts' ? IMAGE_TO_VIDEO_PROMPT_INSTRUCTION : REVERSE_IMAGE_PROMPT_INSTRUCTION}`;
    if (canvasId) await this.canvas.assertWriteAccess(String(canvasId), { leaseToken: String(leaseToken || ''), leaseEpoch: Number(leaseEpoch), expectedRevision: Number(expectedRevision) });
    const begun = await this.runs.begin({ provider: 'codex2api', canvasId: String(canvasId || '') || null, nodeId: String(nodeId || '') || null, shotId: String(shotId || '') || null, parentRunId: String(parentRunId || '') || null, capabilityId: 'image-analysis', capabilityVersion: String(fields.model || 'default'), inputSnapshot: { ...fields, carrotOutputMode: carrotOutputMode || 'text', ...(promptIntent ? { carrotPromptIntent: promptIntent } : {}) }, actorType: actorType === 'agent' ? 'agent' : 'human', actorId: String(actorId || 'web'), idempotencyKey: String(idempotencyKey || '') || null });
    if (begun.replay) return { runId: begun.run.id, replay: true, run: begun.run };
    try {
      await this.runs.patch(begun.run.id, { status: 'running', startedAt: Date.now() });
      const payload = await this.service.forwardMultipart('/v1/images/analyze', files || [], fields);
      const rawText = extractText(payload);
      const outputParts = structuredPromptMode ? parsePromptParts(rawText) : null;
      if (structuredPromptMode && !outputParts) {
        throw Object.assign(new Error('模型未返回可解析的正向与负向提示词，请重试'), { code: 'STRUCTURED_PROMPT_INVALID' });
      }
      const outputText = outputParts ? combinePromptParts(outputParts) : rawText;
      if (outputParts) normalizePayloadText(payload, outputText!);
      await this.runs.finish(begun.run.id, 'succeeded', [], null, outputText, outputParts);
      return { ...payload, runId: begun.run.id, outputParts };
    }
    catch (error) {
      const detail = { code: (error as any)?.code, message: (error as Error).message };
      await this.runs.finish(begun.run.id, 'failed', [], detail);
      if (detail.code === 'STRUCTURED_PROMPT_INVALID') throw new BadGatewayException(detail);
      throw error;
    }
  }
}

function extractText(payload: any): string | null {
  const text = payload?.choices?.[0]?.message?.content ?? payload?.text ?? payload?.data?.[0]?.text;
  return typeof text === 'string' && text.trim() ? text : null;
}

function extractStreamText(raw: string): string | null {
  let text = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { text += JSON.parse(data)?.choices?.[0]?.delta?.content ?? ''; } catch { /* ignore incomplete/non-JSON provider events */ }
  }
  return text.trim() ? text : null;
}

const IMAGE_PROMPT_SYSTEM = '你是图像生成提示词编辑器。根据用户需求只返回一个 JSON 对象，不要 Markdown，不要解释。格式必须是 {"positive":"希望画面出现的主体、构图、光线、风格等完整正向提示词","negative":"需要排除的低质量、畸形、文字、水印等完整负向提示词"}。两个字段都必须是字符串。';
const REVERSE_IMAGE_PROMPT_INSTRUCTION = '你是图片提示词反推器。理解输入图片，生成可供文生图模型尽可能复现其可见视觉特征的提示词。正向提示词应覆盖主体及属性、动作姿态、环境与前中后景、构图、视角、景别与镜头感、光线、色彩、材质、艺术或摄影风格和画面质量。只描述图片中可观察或可合理推断的信息；不得声称恢复原始 prompt，不得编造作者、生成模型、seed、LoRA、采样器或其他不可见参数。只返回一个 JSON 对象，不要 Markdown，不要解释。格式必须是 {"positive":"用于近似复现输入图片的完整正向提示词","negative":"需要排除的内容、常见瑕疵以及与原图不符的特征"}。两个字段都必须是非空字符串。';
const VIDEO_PROMPT_SYSTEM = '你是文生视频提示词编辑器。根据用户需求只返回一个 JSON 对象，不要 Markdown，不要解释。格式必须是 {"positive":"包含主体与场景、动作过程、镜头运动、速度节奏、环境动态、光线风格和时间连续性的完整视频正向提示词","negative":"需要排除的闪烁、跳帧、主体漂移、身份变化、动作突变、肢体形变、镜头抖动、文字水印和低质量等完整视频负向提示词"}。两个字段都必须是字符串。';
const IMAGE_TO_VIDEO_PROMPT_INSTRUCTION = '你是图生视频提示词编辑器。理解输入图片后，保持图片中已确定的主体身份、服装、场景、构图和视觉风格，重点描述接下来发生的主体动作、镜头运动、速度节奏和环境动态，不随意增加新主体。只返回一个 JSON 对象，不要 Markdown，不要解释。格式必须是 {"positive":"保持原图一致性的完整图生视频正向提示词","negative":"需要排除的闪烁、跳帧、主体漂移、身份或服装变化、动作突变、肢体形变、镜头抖动、文字水印和低质量等完整负向提示词"}。两个字段都必须是字符串。';

function parsePromptParts(text: string | null): { positive: string; negative: string } | null {
  if (!text) return null;
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(candidate);
    const positive = typeof parsed?.positive === 'string' ? parsed.positive.trim() : '';
    const negative = typeof parsed?.negative === 'string' ? parsed.negative.trim() : '';
    return positive && negative ? { positive, negative } : null;
  } catch { return null; }
}

function combinePromptParts(parts: { positive: string; negative: string }) {
  return `正向提示词：${parts.positive}\n\n负向提示词：${parts.negative}`;
}

function normalizePayloadText(payload: any, text: string) {
  if (payload?.choices?.[0]?.message) payload.choices[0].message.content = text;
  else if (typeof payload?.text === 'string') payload.text = text;
  else if (payload?.data?.[0] && typeof payload.data[0].text === 'string') payload.data[0].text = text;
}
