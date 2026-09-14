import { Body, Controller, Get, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CanvasIoService, InputFile } from './canvas-io.service';
import { LeaseProof } from './canvas.service';

@Controller('canvas/:id/io')
export class CanvasIoController {
  constructor(private readonly io: CanvasIoService) {}
  @Get() get(@Param('id') id: string) { return this.io.get(id); }
  @Get('inputs/:groupId/update-preview') preview(@Param('id') id: string, @Param('groupId') groupId: string) { return this.io.preview(id, groupId); }
  @Post('command') command(@Param('id') id: string, @Body() dto: LeaseProof & { command: string; payload?: unknown }) { return this.io.command(id, dto, dto.command, dto.payload); }
  @Post('files')
  @UseInterceptors(FilesInterceptor('files', 30, { limits: { fileSize: 256 * 1024 * 1024, files: 30 } }))
  files(@Param('id') id: string, @Body() body: any, @UploadedFiles() files: InputFile[]) { return this.io.importFiles(id, { ...body, leaseEpoch: Number(body.leaseEpoch), expectedRevision: Number(body.expectedRevision) }, files, body.name); }
}
