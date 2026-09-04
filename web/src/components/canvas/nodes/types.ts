/**
 * CarrotCanvas 画布两类节点：类型常量 / data 结构 / 工厂函数（C5，新交互）。
 * 节点 model 来自 CANVAS-INTEGRATION.md §4.2（提示词并入生成节点表单，不做独立提示词节点）：
 *   txt2img（文生图生成，创建即绑定工作流） / result（结果预览）
 * data 中持久化的字段（graph 序列化）：
 *   workflowId/workflowName（绑定）、formValues（表单值，含提示词）、lastAssets（C6 扩展）。
 * 运行/进度等瞬时状态不入 data，刷新后不恢复"运行中"（§4.1）。
 */
import { Node } from '@xyflow/react';

/** 节点类型标识（与 editor nodeTypes key 对应） */
export const NODE_TYPE_TXT2IMG = 'txt2img';
export const NODE_TYPE_RESULT = 'result';
export const NODE_TYPE_CODEX = 'codex-capability';
export type CodexCapability = 'text' | 'image' | 'edit' | 'analyze';

/** 句柄标识：image 数据流（一期唯一连线类型，§4.4），用于连线校验 */
export const HANDLE_IMAGE_SOURCE = 'image-source';
export const HANDLE_IMAGE_TARGET = 'image-target';
export const HANDLE_VIDEO_SOURCE = 'video-source';
export const HANDLE_VIDEO_TARGET = 'video-target';
export const workflowOutputKind = (category?: string): 'image' | 'video' =>
  category === 'txt2vid' || category === 'img2vid' ? 'video' : 'image';
export const resultSourceHandle = (kind: string) => `${kind}-source`;
export const resultTargetHandle = (kind: string) => `${kind}-target`;
/** Codex2API 能力卡片当前只有一个可连接文本字段：提示词。 */
export const capabilityPromptHandle = () => resultTargetHandle('text');
/** 图片端点保留旧 id 兼容已保存画布；其他类型在 id 中携带 kind 供连线校验。 */
export const workflowInputHandle = (nodeId: string, param: string, kind: string = 'image') =>
  kind === 'image' ? `input:${nodeId}:${param}` : `input:${kind}:${nodeId}:${param}`;

/**
 * 文生图生成节点 data。
 * 右键菜单落点即绑定工作流（workflowId/workflowName），提示词并入 formValues 中的多行字段。
 * lastAssets 由 C6 运行成功后写入（平台资产引用）。
 */
export interface Txt2ImgNodeData {
  /** 绑定的工作流 id（category=txt2img），右键菜单落节点时即写入 */
  workflowId?: string;
  /** 绑定工作流名（供显示，不随工作流改名自动同步） */
  workflowName?: string;
  /** 表单值（key=`${nodeId}::${param}`），含提示词字段；C6 提交时值级写回 apiJson */
  formValues?: Record<string, unknown>;
  /** 最近一次成功运行的平台资产引用（C6 写入） */
  lastAssets?: { assetId: string; url: string; kind: string }[];
  [key: string]: unknown;
}

/** 结果节点 data：读上游生成节点 lastAssets 展示，自身不冗余存 */
export interface ResultNodeData {
  // C6：上游 lastAssets 通过连线解析，这里不需要持久化字段
  [key: string]: unknown;
}

export interface CodexCapabilityNodeData {
  capability: CodexCapability;
  prompt: string;
  model: string;
  size?: string;
  responseFormat?: 'url' | 'b64_json';
  stream?: boolean;
  lastText?: string;
  lastAssets?: { assetId: string; url: string; kind: string; filename?: string }[];
  [key: string]: unknown;
}

export type CanvasNodeData = Txt2ImgNodeData | ResultNodeData;

/** 节点类型 → 显示名 */
export const NODE_TYPE_LABEL: Record<string, string> = {
  [NODE_TYPE_TXT2IMG]: '文生图',
  [NODE_TYPE_RESULT]: '结果',
  [NODE_TYPE_CODEX]: 'AI 能力',
};

let nodeSeq = 0;

/** 生成唯一节点 id（前缀含类型便于调试） */
export const newNodeId = (type: string) =>
  `canvas-${type}-${Date.now().toString(36)}-${(nodeSeq++).toString(36)}`;

const NODE_W = 300;

/** 节点外层通用宽度（与 nodes.css 保持一致，用于对齐/避让） */
export const CANVAS_NODE_WIDTH = NODE_W;

/**
 * 文生图生成节点工厂（右键分级菜单落点调用，创建即绑定所选工作流）。
 * position 为右键处经 screenToFlowPosition 转换后的画布坐标，即节点左上角（§4.2.1）。
 */
export function createTxt2ImgNode(
  position: { x: number; y: number },
  workflow: { id: string; name: string },
): Node<Txt2ImgNodeData, typeof NODE_TYPE_TXT2IMG> {
  return {
    id: newNodeId(NODE_TYPE_TXT2IMG),
    type: NODE_TYPE_TXT2IMG,
    position,
    data: { workflowId: workflow.id, workflowName: workflow.name, formValues: {} },
    style: { width: NODE_W },
  };
}

/** 结果节点工厂（一般由运行动作自动创建并连线，§4.3.1；也可单独落点） */
export function createResultNode(position: { x: number; y: number }, kind: 'image' | 'video' = 'image'): Node<ResultNodeData, typeof NODE_TYPE_RESULT> {
  return {
    id: newNodeId(NODE_TYPE_RESULT),
    type: NODE_TYPE_RESULT,
    position,
    data: { kind },
    style: { width: NODE_W },
  };
}


const CAPABILITY_DEFAULTS: Record<CodexCapability, string> = {
  text: '请用三点总结一个优秀创意方案应包含的核心内容。',
  image: '一只戴着护目镜的橙色兔子，在未来感画室里操作发光的绘图台，电影级光影',
  edit: '保留主体构图，把场景改成温暖的日落海边，写实摄影风格',
  analyze: '请详细描述图片中的内容。',
};

export function createCodexCapabilityNode(
  position: { x: number; y: number },
  capability: CodexCapability,
): Node<CodexCapabilityNodeData, typeof NODE_TYPE_CODEX> {
  return {
    id: newNodeId(NODE_TYPE_CODEX), type: NODE_TYPE_CODEX, position,
    data: {
      capability, prompt: CAPABILITY_DEFAULTS[capability], model: 'codex',
      size: '1024x1024', responseFormat: 'url', stream: true,
    },
    style: { width: NODE_W },
  };
}
