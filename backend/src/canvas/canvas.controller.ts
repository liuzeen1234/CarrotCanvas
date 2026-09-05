import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import {
  CanvasService,
  CanvasListItem,
  CreateCanvasDto,
  UpdateCanvasDto,
  LeaseIdentity,
  LeaseProof,
  OperationBatchDto,
} from './canvas.service';
import { CanvasDoc } from './canvas.entity';

@Controller('canvas')
export class CanvasController {
  constructor(private readonly canvas: CanvasService) {}

  /** 画布列表（只回元信息，不回大 graph） */
  @Get()
  list(): Promise<CanvasListItem[]> {
    return this.canvas.list();
  }

  /** 新建画布（body: name?），返回空图画布并创建其资产分区目录 */
  @Post()
  create(@Body() dto: CreateCanvasDto): Promise<CanvasDoc> {
    return this.canvas.create(dto ?? {});
  }

  /** 取单个画布（含完整 graph） */
  @Get(':id')
  findOne(@Param('id') id: string): Promise<CanvasDoc> {
    return this.canvas.findOne(id);
  }

  @Get(':id/agent-view')
  agentView(@Param('id') id: string) { return this.canvas.agentView(id); }

  @Get(':id/control/status')
  controlStatus(@Param('id') id: string) { return this.canvas.controlStatus(id); }

  @Post(':id/control/acquire')
  acquire(@Param('id') id: string, @Body() dto: LeaseIdentity) { return this.canvas.acquire(id, dto); }

  @Post(':id/control/renew')
  renew(@Param('id') id: string, @Body() dto: LeaseProof) { return this.canvas.renew(id, dto); }

  @Post(':id/control/release')
  release(@Param('id') id: string, @Body() dto: LeaseProof) { return this.canvas.release(id, dto); }

  @Post(':id/control/request-handoff')
  requestHandoff(@Param('id') id: string, @Body() dto: LeaseIdentity) { return this.canvas.requestHandoff(id, dto); }

  @Post(':id/control/force-takeover')
  forceTakeover(@Param('id') id: string, @Body() dto: LeaseIdentity & { reason: string }) { return this.canvas.forceTakeover(id, dto); }

  @Post(':id/operations')
  operations(@Param('id') id: string, @Body() dto: OperationBatchDto) { return this.canvas.applyOperations(id, dto); }

  /** 改名 / 保存 graph */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCanvasDto): Promise<CanvasDoc> {
    return this.canvas.update(id, dto ?? {});
  }

  /** 删除画布（级联清理其资产分区目录与 asset 行） */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Body() dto: LeaseProof): Promise<void> {
    await this.canvas.remove(id, dto ?? {});
  }
}
