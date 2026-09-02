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

  /** 改名 / 保存 graph */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCanvasDto): Promise<CanvasDoc> {
    return this.canvas.update(id, dto ?? {});
  }

  /** 删除画布（级联清理其资产分区目录与 asset 行） */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.canvas.remove(id);
  }
}
