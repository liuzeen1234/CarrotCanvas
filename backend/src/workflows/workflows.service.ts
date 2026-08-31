import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow } from './workflow.entity';
import { ComfyUIValidator } from './comfyui-validator';
import { WorkflowCategory, WORKFLOW_CATEGORIES, CATEGORY_LABEL_MAP } from './workflow-category';

export interface WorkflowMeta {
  name: string;
  category?: WorkflowCategory;
  description?: string;
  tags?: string[];
  thumbnailPath?: string;
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
    };
  }
}
