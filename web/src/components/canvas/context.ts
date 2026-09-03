/**
 * CarrotCanvas 画布节点 data 更新通道（C5）。
 * 自定义节点不能直接改受控 nodes 数组；通过本 context 把 data 变更交回编辑器
 * （编辑器 setNodes 同步 state，C7 保存 graph 时直接读受控 state 即可）。
 * 不放入 React Flow 自带 updateNodeData，因其修改内部 store 不回传受控 nodes state，
 * 会导致后续 setNodes（如添加节点）把 data 变更覆盖丢失。
 */
import { createContext } from 'react';
import type { RunStateData } from '../comfyui/types';

export interface CanvasResultState {
  run: RunStateData | null;
  assets: { assetId: string; url: string; kind: string; filename?: string }[];
}

export interface CanvasNodeDataApi {
  /** 局部更新某节点 data（浅合并） */
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 删除某节点（同时移除其相连边）。二次确认由节点自身 UI 负责。 */
  deleteNode: (nodeId: string) => void | Promise<void>;
  canvasId?: string;
  ensureResultNode: (sourceNodeId: string, kind?: 'image' | 'video') => void;
  setNodeRunState: (nodeId: string, run: RunStateData | null) => void;
  getResultState: (resultNodeId: string) => CanvasResultState;
  getUpstreamAsset: (targetNodeId: string, targetHandle: string, kind: string) => CanvasResultState['assets'][number] | null;
}

export const CanvasNodeDataContext = createContext<CanvasNodeDataApi>({
  updateNodeData: () => {},
  deleteNode: () => {},
  ensureResultNode: () => {},
  setNodeRunState: () => {},
  getResultState: () => ({ run: null, assets: [] }),
  getUpstreamAsset: () => null,
});
