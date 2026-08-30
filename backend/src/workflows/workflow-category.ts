export const WORKFLOW_CATEGORIES = [
  { value: 'txt2img', label: '文生图' },
  { value: 'img2img', label: '图生图' },
  { value: 'txt2vid', label: '文生视频' },
  { value: 'img2vid', label: '图生视频' },
  { value: 'vid2vid', label: '视频生视频' },
  { value: 'reference', label: '全能参考' },
] as const;

export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number]['value'];

export const CATEGORY_LABEL_MAP: Record<WorkflowCategory, string> = Object.fromEntries(
  WORKFLOW_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<WorkflowCategory, string>;
