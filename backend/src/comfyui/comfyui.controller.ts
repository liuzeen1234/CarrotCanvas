import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Readable } from 'stream';
import { ComfyUIClientService } from './comfyui-client';
import { ComfyUIGraphConverter } from './comfyui-graph-converter';
import { ComfyUIRunnerService, RunState } from './comfyui-runner.service';
import { ComfyUISchemaService, SchemaAnalysis } from './comfyui-schema.service';
import { ComfyUIAssetCaptureService } from './comfyui-capture.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ComfyUIValidator } from '../workflows/comfyui-validator';
import { WorkflowCategory } from '../workflows/workflow-category';
import { CanvasService } from '../canvas/canvas.service';
import { AssetsService } from '../assets/assets.service';
import { promises as fs } from 'fs';

interface PreviewBody {
  filename: string;
}

interface ImportBody {
  filename: string;
  name?: string;
  category?: WorkflowCategory;
  description?: string;
  tags?: string[];
  exposure?: { version: number; fields: { nodeId: string; param: string }[] } | null;
  inputConfig?: { version: number; fields: { nodeId: string; param: string; kind: 'image' | 'video' | 'audio' | 'text' }[] } | null;
  fieldConfig?: { version: number; fields: { nodeId: string; param: string; label?: string; description?: string }[]; groups?: { nodeId: string; label: string }[] } | null;
}

interface RunBody {
  workflowId: string;
  /** 可选：直接提交的 API JSON（前端 JSONText 编辑兜底） */
  apiJson?: unknown;
  /** 画布上下文（画布生成节点发起时带）：成功后将输出捕获进该画布资产分区 */
  canvasId?: string;
  /** 画布内节点 id（覆盖清理键，需与 canvasId 同传） */
  nodeId?: string;
}

@Controller('comfyui')
export class ComfyUIController {
  constructor(
    private readonly client: ComfyUIClientService,
    private readonly runner: ComfyUIRunnerService,
    private readonly workflows: WorkflowsService,
    private readonly schemaService: ComfyUISchemaService,
    private readonly capture: ComfyUIAssetCaptureService,
    private readonly canvas: CanvasService,
    private readonly assets: AssetsService,
  ) {}

  // ---------- 步骤②：工作流导入 ----------

  /** 列出 ComfyUI 已保存工作流 */
  @Get('workflows')
  async listWorkflows() {
    const files = await this.client.listWorkflows();
    return { files };
  }

  /** 预览：拉取 UI 工作流 → 转换 → 返回 API JSON 与校验信息 */
  @Post('workflows/preview')
  async previewWorkflow(@Body() body: PreviewBody) {
    if (!body.filename) {
      throw new HttpException('缺少 filename 参数', HttpStatus.BAD_REQUEST);
    }
    const uiJson = await this.client.getWorkflowJson(body.filename);
    const objectInfo = await this.client.getObjectInfo();
    const result = ComfyUIGraphConverter.convert(uiJson, objectInfo);

    // 分析可编辑字段 + 计算智能预勾建议（供导入弹窗勾选表使用）
    const schema = result.apiJson
      ? this.schemaService.analyze(
          result.apiJson as Record<string, unknown>,
          objectInfo,
        )
      : null;
    const suggestedCategory = this.guessCategory(result.apiJson);
    const suggestedExposure = schema
      ? this.suggestExposure(schema, suggestedCategory)
      : { version: 1, fields: [] };
    const suggestedInputConfig = schema ? this.suggestInputs(schema) : { version: 1, fields: [] };

    const filename = body.filename.replace(/\.(json|bak)$/i, '');
    return {
      filename: body.filename,
      derivedName: filename,
      suggestedCategory,
      apiJson: result.apiJson ?? null,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      nodeCount: result.nodeCount,
      format: this.detectFormat(uiJson),
      schema,
      suggestedExposure,
      suggestedInputConfig,
      suggestedFieldConfig: schema ? this.suggestFieldConfig(schema) : { version: 1, fields: [] },
    };
  }

  /** 导入：拉取 UI 工作流 → 转换 → 校验 → 入库 */
  @Post('workflows/import')
  async importWorkflow(@Body() body: ImportBody) {
    if (!body.filename) {
      throw new HttpException('缺少 filename 参数', HttpStatus.BAD_REQUEST);
    }
    const uiJson = await this.client.getWorkflowJson(body.filename);
    const objectInfo = await this.client.getObjectInfo();
    const result = ComfyUIGraphConverter.convert(uiJson, objectInfo);

    if (!result.ok || !result.apiJson) {
      throw new HttpException(
        `工作流转换失败：${result.errors.join('；')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const name = (body.name || body.filename.replace(/\.(json|bak)$/i, '')).trim();
    const created = await this.workflows.create({
      name,
      category: body.category ?? this.guessCategory(result.apiJson),
      description: body.description,
      tags: body.tags,
      content: JSON.stringify(result.apiJson),
      exposureConfig: body.exposure ?? null,
      inputConfig: body.inputConfig ?? null,
      fieldConfig: body.fieldConfig ?? null,
    });
    return { workflow: created, warnings: result.warnings, nodeCount: result.nodeCount };
  }

  // ---------- 步骤④：schema 分析 ----------

  /** 分析工作流的可编辑入参（apiJson + /object_info），供前端渲染动态表单 */
  @Get('workflows/:workflowId/schema')
  async workflowSchema(@Param('workflowId') workflowId: string) {
    const workflow = await this.workflows.findOne(workflowId);
    const objectInfo = await this.client.getObjectInfo();
    const analysis = this.schemaService.analyze(
      workflow.apiJson as Record<string, unknown>,
      objectInfo,
    );
    this.applyFieldConfig(analysis, this.suggestFieldConfig(analysis));
    this.applyFieldConfig(analysis, workflow.fieldConfig);
    return { schema: analysis };
  }

  // ---------- 步骤③：运行执行 ----------

  /** 提交运行 */
  @Post('runs')
  async run(@Body() body: RunBody) {
    if (!body.workflowId) {
      throw new HttpException('缺少 workflowId 参数', HttpStatus.BAD_REQUEST);
    }
    const workflow = await this.workflows.findOne(body.workflowId);

    // 画布节点发起：先确认画布存在，避免把产物捕获到不存在的分区
    if (body.canvasId) {
      await this.canvas.findOne(body.canvasId);
    }

    let apiJson: Record<string, unknown>;
    if (body.apiJson !== undefined) {
      const parsed = ComfyUIValidator.parseJson(JSON.stringify(body.apiJson));
      if (!parsed.ok) {
        throw new HttpException(parsed.error, HttpStatus.BAD_REQUEST);
      }
      const errors = ComfyUIValidator.validate(parsed.value);
      if (errors.length) {
        throw new HttpException(errors.join('；'), HttpStatus.BAD_REQUEST);
      }
      apiJson = parsed.value as Record<string, unknown>;
    } else {
      apiJson = workflow.apiJson as Record<string, unknown>;
    }

    const run = await this.runner.submit(apiJson, {
      workflowId: workflow.id,
      title: workflow.name,
      canvasId: body.canvasId,
      nodeId: body.nodeId ?? null,
      // 画布节点运行成功 → 捕获输出字节进画布资产分区（C2）
      onComplete: async (finished) => {
        if (!body.canvasId) return;
        await this.capture.captureRunOutputs(
          finished,
          body.canvasId,
          body.nodeId ?? null,
          workflow.id,
        );
      },
      // 不再自动写回缩略图：改由前端在结果区点"作为封面"手动设置
    });
    return { run };
  }

  /** 运行状态（供前端轮询） */
  @Get('runs/:promptId')
  getRun(@Param('promptId') promptId: string) {
    const run = this.runner.getRun(promptId);
    if (!run) {
      return { run: null };
    }
    return { run };
  }

  /** 最近运行列表 */
  @Get('runs')
  listRuns() {
    return { runs: this.runner.listRuns() };
  }

  /** 中断运行 */
  @Post('runs/:promptId/interrupt')
  async interrupt(@Param('promptId') _promptId: string) {
    await this.runner.interrupt();
    return { ok: true };
  }

  /** 图片代理：从 ComfyUI /view 拉取输出图片并转发 */
  @Get('view')
  async view(@Query() query: Record<string, string>, @Res() res: any) {
    const filename = query.filename;
    if (!filename) {
      throw new HttpException('缺少 filename 参数', HttpStatus.BAD_REQUEST);
    }
    const base = await this.client.getServerUrl();
    const qs = new URLSearchParams({ filename });
    if (query.type) qs.set('type', query.type);
    if (query.subfolder) qs.set('subfolder', query.subfolder);

    const upstream = `${base}/view?${qs.toString()}`;
    const resp = await fetch(upstream);
    if (!resp.ok) {
      res.status(resp.status).send('image fetch failed');
      return;
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = Readable.fromWeb(resp.body as import('stream/web').ReadableStream);
    stream.pipe(res);
  }

  // ---------- 步骤⑥：图片上传 ----------

  /** 上传图片到 ComfyUI input 目录（base64 JSON 转发，避免引入 multer） */
  @Post('upload/image')
  async uploadImage(@Body() body: { filename?: string; dataBase64?: string }) {
    if (!body.dataBase64) {
      throw new HttpException('缺少 dataBase64 参数', HttpStatus.BAD_REQUEST);
    }
    let buf: Buffer;
    try {
      const raw = body.dataBase64.replace(/^data:[^;]+;base64,/, '');
      buf = Buffer.from(raw, 'base64');
    } catch {
      throw new HttpException('dataBase64 解码失败', HttpStatus.BAD_REQUEST);
    }
    if (buf.length === 0) {
      throw new HttpException('文件内容为空', HttpStatus.BAD_REQUEST);
    }
    const name = (body.filename || 'upload.png')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    if (!name) {
      throw new HttpException('无效的文件名', HttpStatus.BAD_REQUEST);
    }
    const file = await this.client.uploadImage(buf, name);
    return { file };
  }

  // ---------- 辅助 ----------

  /**
   * 智能预勾建议：默认暴露"图片上传"与"多行提示词"字段；
   * 图生图额外暴露 denoise（重绘强度），其余字段进高级折叠区。
   */
  private suggestExposure(schema: SchemaAnalysis, category: WorkflowCategory): {
    version: number;
    fields: { nodeId: string; param: string }[];
  } {
    const fields: { nodeId: string; param: string }[] = [];
    for (const group of schema.groups) {
      for (const f of group.fields) {
        const isImg2ImgDenoise = category === 'img2img'
          && f.param.toLowerCase() === 'denoise'
          && (f.control === 'input_number' || f.control === 'slider');
        if (f.control === 'upload' || (f.control === 'textarea' && f.multiline) || isImg2ImgDenoise) {
          fields.push({ nodeId: f.nodeId, param: f.param });
        }
      }
    }
    return { version: 1, fields };
  }

  /** 将画布平台资产安全回灌到 ComfyUI input，供下游工作流字段使用。 */
  @Post('upload/asset')
  async uploadAsset(@Body() body: { canvasId?: string; assetId?: string }) {
    if (!body.canvasId || !body.assetId) throw new HttpException('缺少 canvasId 或 assetId', HttpStatus.BAD_REQUEST);
    const { asset, absPath } = await this.assets.read(body.assetId);
    if (asset.canvasId !== body.canvasId) throw new HttpException('资产不属于当前画布', HttpStatus.BAD_REQUEST);
    if (asset.kind !== 'image') throw new HttpException(`暂不支持回灌 ${asset.kind} 类型资产`, HttpStatus.BAD_REQUEST);
    const file = await this.client.uploadImage(await fs.readFile(absPath), asset.originName || `${asset.id}.png`);
    return { file, assetId: asset.id, kind: asset.kind };
  }

  private suggestInputs(schema: SchemaAnalysis) {
    const fields: { nodeId: string; param: string; kind: 'image' }[] = [];
    for (const group of schema.groups) for (const f of group.fields) {
      if (f.control === 'upload' || f.valueType === 'IMAGE') fields.push({ nodeId: f.nodeId, param: f.param, kind: 'image' });
    }
    return { version: 1, fields };
  }

  /** 为常见 ComfyUI 参数生成可编辑的中文名称和简短建议。 */
  private suggestFieldConfig(schema: SchemaAnalysis) {
    const known: Record<string, { label: string; description: string }> = {
      denoise: { label: '重绘强度', description: '越低越保留原图，越高越按提示词重绘。轻微调整可用 0.3–0.55，明显改色或改造可从 0.65–0.8 尝试；过高可能改变构图和主体。' },
      seed: { label: '随机种子', description: '相同参数和种子便于复现结果；更换种子可获得不同构图与细节。' },
      noise_seed: { label: '随机种子', description: '相同参数和种子便于复现结果；更换种子可获得不同画面与运动细节。' },
      steps: { label: '采样步数', description: '步数越高通常细节越充分，但生成更慢；Turbo 模型通常使用工作流推荐的较低步数。' },
      cfg: { label: '提示词引导强度', description: '越高越强调提示词，但过高可能产生失真或过饱和；优先使用模型或工作流推荐值。' },
      width: { label: '宽度', description: '输出宽度（像素）。更高分辨率会增加显存占用和生成时间。' },
      height: { label: '高度', description: '输出高度（像素）。更高分辨率会增加显存占用和生成时间。' },
      batch_size: { label: '生成数量', description: '一次生成的图片数量；数量增加会提高显存占用和等待时间。' },
      sampler_name: { label: '采样器', description: '控制采样算法。没有明确需求时建议保留工作流默认值。' },
      scheduler: { label: '调度器', description: '控制降噪过程的步长分布，通常与采样器配套使用；建议保留工作流默认值。' },
      filename_prefix: { label: '文件名前缀', description: '生成文件保存时使用的名称前缀，不影响画面内容。' },
      image: { label: '输入图片', description: '图生图或图生视频的来源图片；画布连线存在时会优先使用上游实际图片。' },
      prompt: { label: '提示词', description: '描述希望生成的最终画面、主体、动作、镜头和风格。尽量直接描述结果，避免含糊的操作指令。' },
    };
    const textFields = schema.groups.flatMap((group) => group.fields).filter((field) => field.param === 'text');
    const textEncodeGroups = schema.groups.filter((group) => /CLIPTextEncode/i.test(group.classType));
    return {
      version: 1,
      groups: schema.groups.map((group) => {
        const textIndex = textEncodeGroups.findIndex((item) => item.nodeId === group.nodeId);
        const label = textIndex === 0 ? '正向提示词' : textIndex === 1 ? '负向提示词' : this.suggestGroupLabel(group.classType, group.nodeTitle);
        return { nodeId: group.nodeId, label };
      }),
      fields: schema.groups.flatMap((group) => group.fields).map((field) => {
        let suggestion = known[field.param.toLowerCase()];
        if (!suggestion && field.param === 'text') {
          const index = textFields.findIndex((item) => item.nodeId === field.nodeId && item.param === field.param);
          suggestion = index === 0
            ? { label: '正向提示词', description: '描述希望画面中出现的内容、主体、构图、光线和风格。' }
            : { label: '负向提示词', description: '描述需要排除的内容，例如低质量、畸形、文字、水印或不希望出现的颜色。' };
        }
        return { nodeId: field.nodeId, param: field.param, ...(suggestion ?? { label: field.label, description: '' }) };
      }),
    };
  }

  private suggestGroupLabel(classType: string, nodeTitle: string): string {
    const known: Array<[RegExp, string]> = [
      [/CLIPTextEncode/i, '提示词'],
      [/LoadImage/i, '输入图片'],
      [/KSampler|SamplerCustom/i, '生成参数'],
      [/SaveImage|PreviewImage/i, '输出设置'],
      [/UNETLoader|CheckpointLoader/i, '模型设置'],
      [/CLIPLoader/i, '文本模型设置'],
      [/VAELoader|VAEEncode|VAEDecode/i, '图像编码设置'],
      [/EmptyLatent|EmptySD3/i, '画布尺寸'],
      [/ModelSampling/i, '模型采样设置'],
      [/SaveVideo|VHS_VideoCombine/i, '视频输出设置'],
    ];
    return known.find(([pattern]) => pattern.test(classType))?.[1] ?? nodeTitle;
  }

  private applyFieldConfig(
    schema: SchemaAnalysis,
    config: { fields: { nodeId: string; param: string; label?: string; description?: string }[]; groups?: { nodeId: string; label: string }[] } | null,
  ) {
    if (!config) return;
    const groups = new Map((config.groups ?? []).map((group) => [group.nodeId, group.label]));
    for (const group of schema.groups) {
      const label = groups.get(group.nodeId);
      if (label) group.nodeTitle = label;
    }
    if (!config.fields?.length) return;
    const metadata = new Map(config.fields.map((field) => [`${field.nodeId}::${field.param}`, field]));
    for (const group of schema.groups) for (const field of group.fields) {
      const custom = metadata.get(`${field.nodeId}::${field.param}`);
      if (custom?.label) field.label = custom.label;
      if (custom?.description) field.description = custom.description;
    }
  }

  /** 按节点类型粗略推断分类 */
  private guessCategory(apiJson: Record<string, unknown> | undefined): WorkflowCategory {
    if (!apiJson) return 'reference';
    const types = new Set<string>();
    for (const node of Object.values(apiJson)) {
      const n = node as { class_type?: string };
      if (n?.class_type) types.add(n.class_type);
    }
    const has = (kw: RegExp) => [...types].some((t) => kw.test(t));
    if (has(/Video|SaveAnimated|SaveWEBM|Minimax|Hunyuan|Mochi|Wan\d|LTX/)) {
      if (has(/LoadImage|LoadImagePath|LoadVideo/)) return 'img2vid';
      return 'txt2vid';
    }
    if (has(/LoadImage|LoadImagePath/)) return 'img2img';
    if (has(/CheckpointLoader|UNETLoader|KSampler|EmptyLatentImage|EmptySD3/)) return 'txt2img';
    return 'reference';
  }

  private detectFormat(uiJson: unknown): string {
    const root = uiJson as { nodes?: Record<string, unknown>[] };
    if (!Array.isArray(root?.nodes)) return 'unknown';
    const anyNode = root.nodes.find((n) => n && typeof n === 'object');
    const node = anyNode as Record<string, unknown> | undefined;
    if (node && node.widgets_values_named && typeof node.widgets_values_named === 'object') {
      return 'new';
    }
    return 'legacy';
  }
}
