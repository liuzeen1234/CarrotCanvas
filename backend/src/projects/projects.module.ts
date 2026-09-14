import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsModule } from '../assets/assets.module';
import { CanvasModule } from '../canvas/canvas.module';
import { Project, ProjectCanvas, ProjectReceipt } from './project.entity';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
@Module({ imports: [TypeOrmModule.forFeature([Project, ProjectCanvas, ProjectReceipt]), AssetsModule, CanvasModule], controllers: [ProjectsController], providers: [ProjectsService] })
export class ProjectsModule {}
