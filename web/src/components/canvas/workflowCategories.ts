/**
 * 工作流分类（前端副本，与后端 backend/src/workflows/workflow-category.ts 保持一致）。
 * 用于画布右键分级菜单一级项与颜色。前端无法直接 import 后端模块，故此处维护副本。
 */
export const WORKFLOW_CATEGORIES = [
  { value: 'txt2img', label: '文生图' },
  { value: 'img2img', label: '图生图' },
  { value: 'txt2vid', label: '文生视频' },
  { value: 'img2vid', label: '图生视频' },
  { value: 'vid2vid', label: '视频生视频' },
  { value: 'reference', label: '全能参考' },
] as const;

export type WorkflowCategoryValue = (typeof WORKFLOW_CATEGORIES)[number]['value'];

/** 分类颜色（与设置页保持一致） */
export const CATEGORY_COLORS: Record<string, string> = {
  txt2img: 'blue',
  img2img: 'green',
  txt2vid: 'purple',
  img2vid: 'cyan',
  vid2vid: 'orange',
  reference: 'gold',
};
