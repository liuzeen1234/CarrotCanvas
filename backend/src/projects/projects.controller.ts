import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ProjectCommand, ProjectsService } from './projects.service';
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}
  @Get() list() { return this.projects.list(); }
  @Post() create(@Body() dto: any) { return this.projects.create(dto ?? {}); }
  @Get(':id') get(@Param('id') id: string) { return this.projects.get(id); }
  @Post(':id/command') command(@Param('id') id: string, @Body() dto: ProjectCommand) { return this.projects.command(id, dto); }
  @Delete(':id') remove(@Param('id') id: string, @Body() dto: { expectedRevision: number }) { return this.projects.remove(id, dto.expectedRevision); }
}
