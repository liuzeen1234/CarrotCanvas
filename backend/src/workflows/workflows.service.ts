import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow, ExposureConfig, WorkflowInputConfig, WorkflowPortKind } from './workflow.entity';
import { ComfyUIValidator } from './comfyui-validator';
import { WorkflowCategory, WORKFLOW_CATEGORIES, CATEGORY_LABEL_MAP } from './workflow-category';

export interface WorkflowMeta {
  name: string;
  category?: WorkflowCategory;
  description?: string;
  tags?: string[];
  thumbnailPath?: string;
  exposureConfig?: ExposureConfig | null;
  inputConfig?: WorkflowInputConfig | null;
}

export interface ImportWorkflowDto extends WorkflowMeta {
  content: string;
}

export type CreateWorkflowInput = Omit<ImportWorkflowDto, 'name'> & { name?: string };

export interface WorkflowResponse {
  id: string;
  name: string;
  category: WorkflowCategory;
  categoryLabel: string;
  description: string | null;
  tags: string[] | null;
  apiJson: unknown;
  thumbnailPath: string | null;
  exposureConfig: ExposureConfig | null;
  inputConfig: WorkflowInputConfig | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectRepository(Workflow)
    private readonly repo: Repository<Workflow>,
  ) {}

  async findAll(): Promise<WorkflowResponse[]> {
    const list = await this.repo.find({ order: { createdAt: 'DESC' } });
    return list.map((w) => this.serialize(w));
  }

  async findOne(id: string): Promise<WorkflowResponse> {
    const workflow = await this.repo.findOne({ where: { id } });
    if (!workflow) {
      throw new NotFoundException(`ComfyUI API ${id} 不存在`);
    }
    return this.serialize(workflow);
  }

  async create(dto: CreateWorkflowInput): Promise<WorkflowResponse> {
    const category = this.validateCategory(dto.category);
    const { apiJson } = this.validateContent(dto.content);
    const workflow = this.repo.create({
      name: (dto.name || '未命名 ComfyUI API').trim(),
      category,
      description: dto.description ?? null,
      tags: dto.tags?.length ? dto.tags : null,
      apiJson,
      thumbnailPath: dto.thumbnailPath ?? null,
      exposureConfig: this.normalizeExposure(dto.exposureConfig),
      inputConfig: this.normalizeInputConfig(dto.inputConfig),
    });
    const saved = await this.repo.save(workflow);
    return this.serialize(saved);
  }

  async update(
    id: string,
    dto: Partial<WorkflowMeta> & { content?: string },
  ): Promise<WorkflowResponse> {
    const workflow = await this.repo.findOne({ where: { id } });
    if (!workflow) {
      throw new NotFoundException(`ComfyUI API ${id} 不存在`);
    }

    if (dto.name !== undefined) workflow.name = dto.name.trim();
    if (dto.category !== undefined) workflow.category = this.validateCategory(dto.category);
    if (dto.description !== undefined) workflow.description = dto.description;
    if (dto.tags !== undefined) workflow.tags = dto.tags?.length ? dto.tags : null;
    if (dto.thumbnailPath !== undefined) workflow.thumbnailPath = dto.thumbnailPath;
    if (dto.exposureConfig !== undefined) {
      workflow.exposureConfig = this.normalizeExposure(dto.exposureConfig);
    }
    if (dto.inputConfig !== undefined) workflow.inputConfig = this.normalizeInputConfig(dto.inputConfig);
    if (dto.content !== undefined) {
      const { apiJson } = this.validateContent(dto.content);
      workflow.apiJson = apiJson;
    }

    const saved = await this.repo.save(workflow);
    return this.serialize(saved);
  }

  async remove(id: string): Promise<void> {
    const workflow = await this.repo.findOne({ where: { id } });
    if (!workflow) {
      throw new NotFoundException(`ComfyUI API ${id} 不存在`);
    }
    await this.repo.remove(workflow);
  }

  private validateCategory(category?: WorkflowCategory): WorkflowCategory {
    if (!category) {
      throw new BadRequestException('缺少 API 类型');
    }
    const valid = WORKFLOW_CATEGORIES.some((c) => c.value === category);
    if (!valid) {
      throw new BadRequestException(
        `无效的 API 类型"${category}"，可选值：${WORKFLOW_CATEGORIES.map((c) => c.value).join('、')}`,
      );
    }
    return category;
  }

  /** 规整暴露配置：去掉非法项，空列表/无效输入归一为 null（未配置） */
  private normalizeExposure(
    input: ExposureConfig | null | undefined,
  ): ExposureConfig | null {
    if (input === null || input === undefined) return null;
    const fields = Array.isArray(input.fields) ? input.fields : [];
    const valid = fields.filter(
      (f) =>
        f &&
        typeof f.nodeId === 'string' &&
        f.nodeId.length > 0 &&
        typeof f.param === 'string' &&
        f.param.length > 0,
    );
    if (!valid.length) return null;
    // 去重
    const seen = new Set<string>();
    const deduped = valid.filter((f) => {
      const key = `${f.nodeId}::${f.param}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { version: 1, fields: deduped };
  }

  private normalizeInputConfig(input: WorkflowInputConfig | null | undefined): WorkflowInputConfig | null {
    if (!input || !Array.isArray(input.fields)) return null;
    const kinds = new Set<WorkflowPortKind>(['image', 'video', 'audio', 'text']);
    const seen = new Set<string>();
    const fields = input.fields.filter((f) => {
      if (!f || typeof f.nodeId !== 'string' || !f.nodeId || typeof f.param !== 'string' || !f.param || !kinds.has(f.kind)) return false;
      const key = `${f.nodeId}::${f.param}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return fields.length ? { version: 1, fields } : null;
  }

  private validateContent(content: string): { apiJson: string } {
    const parsed = ComfyUIValidator.parseJson(content);
    if (!parsed.ok) {
      throw new BadRequestException(parsed.error);
    }
    const errors = ComfyUIValidator.validate(parsed.value);
    if (errors.length) {
      throw new BadRequestException(errors.join('；'));
    }
    return { apiJson: JSON.stringify(parsed.value) };
  }

  private serialize(workflow: Workflow): WorkflowResponse {
    const { apiJson, ...rest } = workflow;
    return {
      ...rest,
      categoryLabel: CATEGORY_LABEL_MAP[workflow.category] || workflow.category,
      apiJson: JSON.parse(apiJson),
      exposureConfig: workflow.exposureConfig ?? null,
      inputConfig: workflow.inputConfig ?? null,
    };
  }
}
