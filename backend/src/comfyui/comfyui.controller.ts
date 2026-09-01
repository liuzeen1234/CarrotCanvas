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
import { WorkflowsService } from '../workflows/workflows.service';
import { ComfyUIValidator } from '../workflows/comfyui-validator';
import { WorkflowCategory } from '../workflows/workflow-category';

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
}

interface RunBody {
  workflowId: string;
  /** 可选：直接提交的 API JSON（前端 JSONText 编辑兜底） */
  apiJson?: unknown;
}

@Controller('comfyui')
export class ComfyUIController {
  constructor(
    private readonly client: ComfyUIClientService,
    private readonly runner: ComfyUIRunnerService,
    private readonly workflows: WorkflowsService,
    private readonly schemaService: ComfyUISchemaService,
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
    const suggestedExposure = schema
      ? this.suggestExposure(schema)
      : { version: 1, fields: [] };

    const filename = body.filename.replace(/\.(json|bak)$/i, '');
    return {
      filename: body.filename,
      derivedName: filename,
      suggestedCategory: this.guessCategory(result.apiJson),
      apiJson: result.apiJson ?? null,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      nodeCount: result.nodeCount,
      format: this.detectFormat(uiJson),
      schema,
      suggestedExposure,
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
   * 智能预勾建议：默认暴露"图片上传"与"多行提示词"字段，
   * 其余字段进高级折叠区。用户可在导入弹窗里增删。
   */
  private suggestExposure(schema: SchemaAnalysis): {
    version: number;
    fields: { nodeId: string; param: string }[];
  } {
    const fields: { nodeId: string; param: string }[] = [];
    for (const group of schema.groups) {
      for (const f of group.fields) {
        if (f.control === 'upload' || (f.control === 'textarea' && f.multiline)) {
          fields.push({ nodeId: f.nodeId, param: f.param });
        }
      }
    }
    return { version: 1, fields };
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
