import { Controller, Get, Post, Patch, Delete, Body, Param, HttpCode } from '@nestjs/common';
import { WorkflowsService, WorkflowResponse } from './workflows.service';
import { WorkflowCategory, WORKFLOW_CATEGORIES } from './workflow-category';
import { ExposureConfig } from './workflow.entity';

export interface CreateWorkflowDto {
  name?: string;
  category?: WorkflowCategory;
  description?: string;
  tags?: string[];
  content: string;
  exposureConfig?: ExposureConfig | null;
}

export interface UpdateWorkflowDto {
  name?: string;
  category?: WorkflowCategory;
  description?: string;
  tags?: string[];
  thumbnailPath?: string;
  content?: string;
  exposureConfig?: ExposureConfig | null;
}

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get('categories')
  getCategories() {
    return WORKFLOW_CATEGORIES;
  }

  @Get()
  findAll(): Promise<WorkflowResponse[]> {
    return this.workflowsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<WorkflowResponse> {
    return this.workflowsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateWorkflowDto): Promise<WorkflowResponse> {
    return this.workflowsService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
  ): Promise<WorkflowResponse> {
    return this.workflowsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.workflowsService.remove(id);
  }
}
