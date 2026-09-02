/**
 * CarrotCanvas 共享 ComfyUI 运行类型与纯函数。
 * 由设置页运行面板（ComfyRunModal）与画布生成节点（C5/C6）共用，
 * 禁止两处各写一套。来源：ComfyUIAPIManager.tsx 运行面板抽取（C4）。
 */

export interface ExposedField {
  nodeId: string;
  param: string;
}

export interface ExposureConfig {
  version: number;
  fields: ExposedField[];
}

export interface ComfyUIAPI {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  tags: string[] | null;
  apiJson: unknown;
  thumbnailPath: string | null;
  exposureConfig: ExposureConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  kind: 'image' | 'video' | 'audio' | 'other';
}

/** ComfyUI 运行终态（到达即停止轮询） */
export const TERMINAL_RUN_STATUS = ['success', 'error', 'interrupted', 'unknown'] as const;

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'interrupted' | 'unknown';

export interface RunStateData {
  promptId: string;
  workflowId?: string;
  title: string;
  status: string;
  queuedAt: number;
  currentNode?: string | null;
  currentNodeTitle?: string;
  progress?: { value: number; max: number };
  nodes: Record<string, { value: number; max: number; state: string }>;
  nodeTitles: Record<string, string>;
  outputs: RunOutputFile[];
  error?: string;
  nodeErrors: Record<string, unknown>;
}

export interface SchemaField {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  param: string;
  label: string;
  control: 'input_number' | 'slider' | 'textarea' | 'input' | 'select' | 'switch' | 'upload' | 'hidden';
  valueType: string;
  current: unknown;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: (string | number)[];
  multiline?: boolean;
  imageUpload?: boolean;
}

export interface SchemaNodeGroup {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  fields: SchemaField[];
}

export interface SchemaAnalysis {
  ok: boolean;
  source: string;
  groups: SchemaNodeGroup[];
  warnings: string[];
  error?: string;
  nodeCount: number;
  editableCount: number;
  totalFieldCount: number;
}

export type RunMode = 'form' | 'json';

/** 表单值 key：`${nodeId}::${param}` */
export const fileKey = (f: { nodeId: string; param: string }) => `${f.nodeId}::${f.param}`;

/** 把表单值（key=`${nodeId}::${param}`）按值级写入 apiJson 深拷贝（值级替换，非字符串拼接） */
export const applyFormValues = (base: unknown, values: Record<string, unknown>): unknown => {
  const json = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  for (const [key, v] of Object.entries(values)) {
    const idx = key.lastIndexOf('::');
    if (idx <= 0) continue;
    const nodeId = key.slice(0, idx);
    const param = key.slice(idx + 2);
    const node = json[nodeId];
    if (node && typeof node.inputs === 'object' && node.inputs !== null) {
      node.inputs[param] = v;
    }
  }
  return json;
};

/**
 * 按 exposureConfig 把 schema 分组拆成主区（暴露）与高级区（折叠）。
 * exposureConfig 为空 → 全部归主区（回退为平铺，不破坏老数据）。
 */
export const splitByExposure = (
  schema: SchemaAnalysis,
  exposure: ExposureConfig | null,
): { primary: SchemaNodeGroup[]; advanced: SchemaNodeGroup[] } => {
  const exposed = exposure?.fields?.length
    ? new Set(exposure.fields.map((f) => `${f.nodeId}::${f.param}`))
    : null;
  if (!exposed) {
    return { primary: schema.groups, advanced: [] as SchemaNodeGroup[] };
  }
  const primary: SchemaNodeGroup[] = [];
  const advanced: SchemaNodeGroup[] = [];
  for (const g of schema.groups) {
    const p = g.fields.filter((f) => exposed.has(`${f.nodeId}::${f.param}`));
    const a = g.fields.filter((f) => !exposed.has(`${f.nodeId}::${f.param}`));
    if (p.length) primary.push({ ...g, fields: p });
    if (a.length) advanced.push({ ...g, fields: a });
  }
  return { primary, advanced };
};
