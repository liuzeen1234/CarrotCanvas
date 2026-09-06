import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  ReactFlowProvider,
  useReactFlow,
  SelectionMode,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type OnConnectEnd,
  type OnConnectStart,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Drawer, Image, Input, List, Popconfirm, Popover, Segmented, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, DownloadOutlined, DragOutlined, EnvironmentOutlined, HistoryOutlined, PictureOutlined, SaveOutlined, SelectOutlined } from '@ant-design/icons';
import { Link, useParams, request } from 'umi';
import { CanvasNodeDataContext, type CanvasResultState } from '@/components/canvas/context';
import { canvasNodeTypes } from '@/components/canvas/nodes';
import { capabilityPromptHandle, NODE_TYPE_CODEX, NODE_TYPE_RESULT, NODE_TYPE_TXT2IMG, CANVAS_NODE_WIDTH, createCodexCapabilityNode, createResultNode, createTxt2ImgNode, resultSourceHandle, resultTargetHandle, workflowInputHandle, type CodexCapability } from '@/components/canvas/nodes/types';
import CanvasContextMenu, { type CanvasContextMenuState } from '@/components/canvas/CanvasContextMenu';
import { RunDuration } from '@/components/canvas/RunTiming';
import { ComfyUIAPI, type RunStateData } from '@/components/comfyui/types';
import './editor.css';

const { Text } = Typography;

/** 画布文档（含完整 graph） */
interface CanvasDoc {
  id: string;
  name: string;
  graph: {
    version: number;
    nodes: Node[];
    edges: Edge[];
    viewport: Viewport | null;
  };
  createdAt: string;
  updatedAt: string;
  revision: number;
}

interface CanvasLease { leaseToken: string; epoch: number; status: 'active' | 'handoff_pending'; holderType: 'human' | 'agent'; holderId: string; }
interface CanvasControlHolder { holderType: 'human' | 'agent'; holderId: string; status: string; }
interface CanvasRunState extends RunStateData { canvasId?: string; nodeId?: string | null; }
interface OperationLogItem { id: string; resultRevision: number; baseRevision: number; actorType: 'human' | 'agent'; actorId: string; intent: string | null; operations: Array<{ type: string }>; undoneByLogId: string | null; createdAt: string; }
interface CheckpointItem { id: string; name: string; description: string | null; revision: number; createdByType: 'human' | 'agent'; createdById: string; createdAt: string; }
interface GenerationRunItem { id: string; provider: string; status: string; nodeId: string | null; capabilityId: string | null; inputSnapshot: unknown; outputAssetIds: string[]; outputText: string | null; error: { message?: string } | null; attemptCount: number; queuedAt: number; startedAt: number | null; finishedAt: number | null; createdAt: string; latestHandoff?: { outcome: 'released' | 'adopted' | 'release_failed'; fromActorType: 'human' | 'agent'; toActorType: 'human' | 'agent' | null } | null; }

const sourceHandleKind = (handle: string) => handle === 'text-positive-source' || handle === 'text-negative-source'
  ? 'text'
  : handle.endsWith('-source') ? handle.slice(0, -7) : '';

function humanHolderId() {
  const key = 'carrot-canvas:human-holder-id';
  let value = window.sessionStorage.getItem(key);
  if (!value) { value = `human-${crypto.randomUUID()}`; window.sessionStorage.setItem(key, value); }
  return value;
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable], [role="textbox"]'));
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** 只持久化可恢复的 React Flow 数据，剔除选中/拖动/尺寸测量等瞬时 UI 状态。 */
function createPersistedGraph(nodes: Node[], edges: Edge[], _viewport: Viewport | null) {
  return {
    version: 1,
    nodes: nodes.map(({ selected: _selected, dragging: _dragging, measured: _measured, ...node }) => node),
    edges: edges.map(({ selected: _selected, ...edge }) => edge),
    // viewport 是每个浏览器的展示偏好，不属于 canonical canvas state。
    viewport: null,
  };
}

type GraphOperation = Record<string, unknown> & { type: string };
function graphOperations(previous: ReturnType<typeof createPersistedGraph>, next: ReturnType<typeof createPersistedGraph>): GraphOperation[] {
  const beforeNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  // React Flow 扩展字段发生变化时用受同一校验/日志保护的兼容操作兜底。
  for (const [id, before] of beforeNodes) {
    const after = afterNodes.get(id); if (!after) continue;
    const { data: _bd, position: _bp, ...beforeShape } = before;
    const { data: _ad, position: _ap, ...afterShape } = after;
    if (JSON.stringify(beforeShape) !== JSON.stringify(afterShape) || Object.keys((before.data ?? {}) as object).some((key) => !(key in ((after.data ?? {}) as object)))) return [{ type: 'replace_graph', graph: next }];
  }
  for (const [id, before] of beforeEdges) {
    const after = afterEdges.get(id);
    if (after && JSON.stringify(before) !== JSON.stringify(after)) return [{ type: 'replace_graph', graph: next }];
  }
  const deleted = new Set([...beforeNodes.keys()].filter((id) => !afterNodes.has(id)));
  const operations: GraphOperation[] = [];
  for (const [id, edge] of beforeEdges) if (!afterEdges.has(id) && !deleted.has(edge.source) && !deleted.has(edge.target)) operations.push({ type: 'disconnect', edgeId: id });
  for (const id of deleted) operations.push({ type: 'delete_node', nodeId: id });
  for (const [id, node] of afterNodes) if (!beforeNodes.has(id)) operations.push({ type: 'create_node', node });
  const positions: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
  for (const [id, after] of afterNodes) {
    const before = beforeNodes.get(id); if (!before) continue;
    if (JSON.stringify(before.position) !== JSON.stringify(after.position)) positions.push({ nodeId: id, position: after.position });
    if (JSON.stringify(before.data) !== JSON.stringify(after.data)) operations.push({ type: 'update_node', nodeId: id, dataPatch: after.data });
  }
  if (positions.length) operations.push({ type: 'move_nodes', positions });
  for (const [id, edge] of afterEdges) if (!beforeEdges.has(id)) operations.push({ type: 'connect', edge });
  return operations;
}

export default function CanvasEditorPage() {
  // useReactFlow（右键落点 screenToFlowPosition）需要 ReactFlowProvider 祖先
  return (
    <ReactFlowProvider>
      <CanvasEditorInner />
    </ReactFlowProvider>
  );
}

function CanvasEditorInner() {
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [canvasName, setCanvasName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renamingRef = useRef(false);
  const cancelNameBlurRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** doc 已就绪且 nodes/edges 已初始化（避免先渲染一帧空图） */
  const [ready, setReady] = useState(false);
  const [lease, setLease] = useState<CanvasLease | null>(null);
  const [controlMessage, setControlMessage] = useState('正在读取控制权…');
  const [observedHolder, setObservedHolder] = useState<CanvasControlHolder | null>(null);
  const [handoffRequested, setHandoffRequested] = useState(false);
  const revisionRef = useRef(0);
  const leaseRef = useRef<CanvasLease | null>(null);
  leaseRef.current = lease;
  const canWrite = lease?.status === 'active';

  // 受控节点图：C5 编辑器内可添加/删除/连线；自动保存由 C7 落地
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [interactionMode, setInteractionMode] = useState<'hand' | 'pointer'>('hand');
  const [spacePanActive, setSpacePanActive] = useState(false);
  const effectiveInteractionMode = interactionMode === 'pointer' && spacePanActive ? 'hand' : interactionMode;
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [operationLogs, setOperationLogs] = useState<OperationLogItem[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [generationHistoryOpen, setGenerationHistoryOpen] = useState(false);
  const [generationHistoryLoading, setGenerationHistoryLoading] = useState(false);
  const [generationRuns, setGenerationRuns] = useState<GenerationRunItem[]>([]);
  /** 运行态只驻留内存，不进入 graph；结果节点通过 Context 读取上游状态。 */
  const [nodeRuns, setNodeRuns] = useState<Record<string, RunStateData | null>>({});
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const viewportRef = useRef(viewport);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  viewportRef.current = viewport;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef<{ graph: ReturnType<typeof createPersistedGraph>; snapshot: string } | null>(null);
  const lastSavedSnapshotRef = useRef('');
  const lastSavedGraphRef = useRef<ReturnType<typeof createPersistedGraph>>({ version: 1, nodes: [], edges: [], viewport: null });

  /** 右键分级菜单状态（右键屏幕坐标；null = 关闭） */
  const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);

  /** 窄屏（移动端）标志：切换顶栏/内边距布局，避免被挤成竖排 */
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  const [miniMapOpen, setMiniMapOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('carrot-canvas:minimap-open');
    return stored == null ? window.innerWidth >= 768 : stored === 'true';
  });

  /** 桌面端测量内容区剩余高度；移动端直接覆盖系统框架并占满视口。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootHeight, setRootHeight] = useState<number | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || interactionMode !== 'pointer' || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      setSpacePanActive(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      setSpacePanActive(false);
    };
    const stopTemporaryPan = () => setSpacePanActive(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', stopTemporaryPan);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', stopTemporaryPan);
    };
  }, [interactionMode]);

  useEffect(() => {
    const recompute = () => {
      const narrow = window.innerWidth < 768;
      setIsNarrow(narrow);
      const el = rootRef.current;
      if (narrow) {
        setRootHeight(null);
      } else {
        if (!el) return;
        const top = el.getBoundingClientRect().top;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        setRootHeight(Math.max(240, Math.floor(vh - top)));
      }
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.visualViewport?.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.visualViewport?.removeEventListener('resize', recompute);
    };
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.body.classList.add('canvas-editor-page');
    return () => document.body.classList.remove('canvas-editor-page');
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // 切换画布时重置状态，避免残留上一张画的节点
    setDoc(null);
    setReady(false);
    setNodes([]);
    setEdges([]);
    setViewport(null);
    setSaveStatus('idle');
    setLoading(true);
    setLoadError(null);
    Promise.all([
      request<CanvasDoc>(`/api/canvas/${id}`),
      request<any>(`/api/canvas/${id}/control/status`),
    ])
      .then(async ([initialData, initialStatus]) => {
        let data = initialData;
        let status = initialStatus;
        let acquired: CanvasLease | null = null;
        const available = ['available', 'expired', 'revoked'].includes(status?.status);
        if (available) {
          try {
            acquired = await request<CanvasLease>(`/api/canvas/${id}/control/acquire`, { method: 'POST', data: { holderType: 'human', holderId: humanHolderId() } });
            // status 与首次 graph 读取之间可能发生过写入；取得 lease 后重新读取 canonical state。
            data = await request<CanvasDoc>(`/api/canvas/${id}`);
          } catch {
            // 竞争失败表示控制权刚被其他写入者取得，刷新状态并安全退回只读。
            [data, status] = await Promise.all([
              request<CanvasDoc>(`/api/canvas/${id}`),
              request<any>(`/api/canvas/${id}/control/status`),
            ]);
          }
        }
        if (cancelled) {
          if (acquired) void request(`/api/canvas/${id}/control/release`, { method: 'POST', data: { leaseToken: acquired.leaseToken, leaseEpoch: acquired.epoch } });
          return;
        }
        const activeHolder = !acquired && ['active', 'handoff_pending'].includes(status?.status) && status?.lease
          ? { holderType: status.lease.holderType, holderId: status.lease.holderId, status: status.status }
          : null;
        setDoc(data); revisionRef.current = data.revision ?? 0; setLease(acquired); setObservedHolder(activeHolder); setHandoffRequested(false);
        setControlMessage(acquired ? '' : activeHolder ? `由${activeHolder.holderType === 'agent' ? 'AI' : '人工'}持有，当前为只读` : '当前没有控制者，可主动取得编辑权');
        setSaveStatus('saved'); setLastSavedAt(new Date(data.updatedAt)); setSaveError('');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setLoadError(e?.response?.data?.message || '加载画布失败'); setDoc(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // doc 就绪 → 用持久化 graph 初始化受控节点图
  useEffect(() => {
    if (!doc) return;
    const initialNodes = doc.graph?.nodes ?? [];
    const initialEdges = doc.graph?.edges ?? [];
    let localViewport: Viewport | null = null;
    try { localViewport = JSON.parse(window.localStorage.getItem(`carrot-canvas:viewport:${doc.id}`) || 'null'); } catch { /* 忽略损坏的本地偏好 */ }
    const initialViewport = localViewport ?? doc.graph?.viewport ?? null;
    setNodes(initialNodes);
    setEdges(initialEdges);
    setViewport(initialViewport);
    setCanvasName(doc.name);
    lastSavedGraphRef.current = createPersistedGraph(initialNodes, initialEdges, initialViewport);
    lastSavedSnapshotRef.current = JSON.stringify(lastSavedGraphRef.current);
    setReady(true);
  }, [doc]);

  const startRename = useCallback(() => {
    setNameDraft(canvasName);
    setEditingName(true);
  }, [canvasName]);

  const cancelRename = useCallback(() => {
    cancelNameBlurRef.current = true;
    setNameDraft(canvasName);
    setEditingName(false);
    setTimeout(() => {
      cancelNameBlurRef.current = false;
    }, 0);
  }, [canvasName]);

  const submitRename = useCallback(async () => {
    const currentLease = leaseRef.current;
    if (!id || !currentLease || renamingRef.current) return;
    const name = nameDraft.trim();
    if (!name) {
      message.warning('画布名称不能为空');
      setNameDraft(canvasName);
      setEditingName(false);
      return;
    }
    if (name === canvasName) {
      setEditingName(false);
      return;
    }
    renamingRef.current = true;
    setRenaming(true);
    try {
      const saved = await request<CanvasDoc>(`/api/canvas/${id}`, { method: 'PATCH', data: { name, leaseToken: currentLease.leaseToken, leaseEpoch: currentLease.epoch, expectedRevision: revisionRef.current, idempotencyKey: crypto.randomUUID(), actorType: 'human', actorId: currentLease.holderId } });
      revisionRef.current = saved.revision;
      setCanvasName(name);
      setEditingName(false);
      message.success('画布名称已更新');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '画布重命名失败');
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
  }, [canvasName, id, nameDraft]);

  /** 串行写入最新 graph；保存期间继续变化时，完成后立刻追写最新版本，避免旧请求覆盖新状态。 */
  const flushSave = useCallback(async () => {
    const currentLease = leaseRef.current;
    if (!id || !currentLease || saveInFlightRef.current || !pendingSaveRef.current) return;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    saveInFlightRef.current = true;
    setSaveStatus('saving');
    setSaveError('');
    let succeeded = false;
    try {
      const operations = graphOperations(lastSavedGraphRef.current, pending.graph);
      if (!operations.length) { lastSavedSnapshotRef.current = pending.snapshot; setSaveStatus('saved'); succeeded = true; return; }
      const result = await request<{ canvas: CanvasDoc; resultRevision: number }>(`/api/canvas/${id}/operations`, { method: 'POST', data: { operations, intent: '人工编辑画布', leaseToken: currentLease.leaseToken, leaseEpoch: currentLease.epoch, expectedRevision: revisionRef.current, idempotencyKey: crypto.randomUUID(), actorType: 'human', actorId: currentLease.holderId } });
      const saved = result.canvas;
      revisionRef.current = result.resultRevision;
      lastSavedGraphRef.current = pending.graph;
      lastSavedSnapshotRef.current = pending.snapshot;
      setLastSavedAt(new Date(saved.updatedAt));
      setSaveStatus(pendingSaveRef.current ? 'dirty' : 'saved');
      succeeded = true;
    } catch (error: any) {
      pendingSaveRef.current = pendingSaveRef.current ?? pending;
      setSaveStatus('error');
      const detail = error?.response?.data?.message || '画布自动保存失败';
      setSaveError(detail);
      message.error(detail);
    } finally {
      saveInFlightRef.current = false;
      if (succeeded && pendingSaveRef.current && pendingSaveRef.current.snapshot !== lastSavedSnapshotRef.current) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => void flushSave(), 0);
      }
    }
  }, [id]);

  /** 交接前等待当前保存及其追写队列完全排空。 */
  const drainSaves = useCallback(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!saveInFlightRef.current && pendingSaveRef.current) await flushSave();
      if (!saveInFlightRef.current && !pendingSaveRef.current) return;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error('等待画布保存完成超时');
  }, [flushSave]);

  const loadHistory = useCallback(async () => {
    if (!id) return;
    setHistoryLoading(true);
    try {
      const [logs, points] = await Promise.all([
        request<OperationLogItem[]>(`/api/canvas/${id}/operation-log`),
        request<CheckpointItem[]>(`/api/canvas/${id}/checkpoints`),
      ]);
      setOperationLogs(logs); setCheckpoints(points);
    } catch (error: any) { message.error(error?.response?.data?.message || '读取操作历史失败'); }
    finally { setHistoryLoading(false); }
  }, [id]);

  const loadGenerationHistory = useCallback(async () => {
    if (!id) return;
    setGenerationHistoryLoading(true);
    try {
      const result = await request<{ items: GenerationRunItem[] }>(`/api/runs?canvasId=${encodeURIComponent(id)}&pageSize=100`);
      setGenerationRuns(result.items ?? []);
    } catch (error: any) { message.error(error?.response?.data?.message || '读取生成历史失败'); }
    finally { setGenerationHistoryLoading(false); }
  }, [id]);

  const adoptCanvas = useCallback((canvas: CanvasDoc) => {
    revisionRef.current = canvas.revision; setDoc(canvas); setCanvasName(canvas.name);
    setSaveStatus('saved'); setLastSavedAt(new Date(canvas.updatedAt)); setSaveError('');
  }, []);

  const createCheckpoint = useCallback(async () => {
    const current = leaseRef.current; if (!id || !current) return;
    try {
      await drainSaves();
      await request(`/api/canvas/${id}/checkpoints`, { method: 'POST', data: { name: `恢复点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, leaseToken: current.leaseToken, leaseEpoch: current.epoch, expectedRevision: revisionRef.current, actorType: 'human', actorId: current.holderId } });
      message.success('恢复点已创建'); await loadHistory();
    } catch (error: any) { message.error(error?.response?.data?.message || error?.message || '创建恢复点失败'); }
  }, [drainSaves, id, loadHistory]);

  const undoLog = useCallback(async (logId: string) => {
    const current = leaseRef.current; if (!id || !current) return;
    try {
      await drainSaves();
      const result = await request<{ canvas: CanvasDoc }>(`/api/canvas/${id}/operation-log/${logId}/undo`, { method: 'POST', data: { leaseToken: current.leaseToken, leaseEpoch: current.epoch, expectedRevision: revisionRef.current, idempotencyKey: crypto.randomUUID(), actorType: 'human', actorId: current.holderId } });
      adoptCanvas(result.canvas); message.success('操作批次已撤销'); await loadHistory();
    } catch (error: any) { message.error(error?.response?.data?.message || error?.message || '撤销失败'); }
  }, [adoptCanvas, drainSaves, id, loadHistory]);

  const restoreCheckpoint = useCallback(async (checkpointId: string) => {
    const current = leaseRef.current; if (!id || !current) return;
    try {
      await drainSaves();
      const result = await request<{ canvas: CanvasDoc }>(`/api/canvas/${id}/checkpoints/${checkpointId}/restore`, { method: 'POST', data: { leaseToken: current.leaseToken, leaseEpoch: current.epoch, expectedRevision: revisionRef.current, idempotencyKey: crypto.randomUUID(), actorType: 'human', actorId: current.holderId } });
      adoptCanvas(result.canvas); message.success('画布已恢复到所选恢复点'); await loadHistory();
    } catch (error: any) { message.error(error?.response?.data?.message || error?.message || '恢复失败'); }
  }, [adoptCanvas, drainSaves, id, loadHistory]);

  /** 立即把当前最新节点图放入保存队列；无变化时只确认当前已保存。 */
  const manualSave = useCallback(() => {
    if (!id || !canWrite) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const graph = createPersistedGraph(nodesRef.current, edgesRef.current, viewportRef.current);
    const snapshot = JSON.stringify(graph);
    if (snapshot === lastSavedSnapshotRef.current && !pendingSaveRef.current && !saveInFlightRef.current) {
      setSaveStatus('saved');
      return;
    }
    pendingSaveRef.current = { graph, snapshot };
    setSaveStatus(saveInFlightRef.current ? 'dirty' : 'saving');
    setSaveError('');
    if (!saveInFlightRef.current) void flushSave();
  }, [canWrite, flushSave, id]);

  useEffect(() => {
    if (!id || !lease) return;
    const timer = window.setInterval(async () => {
      const current = leaseRef.current;
      if (!current) return;
      try {
        const renewed = await request<CanvasLease>(`/api/canvas/${id}/control/renew`, { method: 'POST', data: { leaseToken: current.leaseToken, leaseEpoch: current.epoch } });
        setLease(renewed);
        if (renewed.status === 'handoff_pending') {
          leaseRef.current = renewed;
          setControlMessage('收到交接请求：正在保存并释放编辑权…');
          await drainSaves();
          const history = await request<{ items: GenerationRunItem[] }>(`/api/runs?canvasId=${encodeURIComponent(id)}&pageSize=1`);
          const latestRun = history.items?.[0];
          if (latestRun) {
            await request(`/api/runs/${latestRun.id}/handoff`, { method: 'POST', data: {
              leaseToken: renewed.leaseToken, leaseEpoch: renewed.epoch, expectedRevision: revisionRef.current,
              actorType: 'human', actorId: humanHolderId(), summary: '人工页面响应控制权请求；继续观察同一 Run，不重复提交或自动取消。',
            } });
          } else {
            await request(`/api/canvas/${id}/control/release`, { method: 'POST', data: { leaseToken: renewed.leaseToken, leaseEpoch: renewed.epoch } });
          }
          setLease(null);
          setObservedHolder(null);
          setControlMessage('编辑权已交接，当前为只读');
        }
      } catch (e: any) { setLease(null); setControlMessage(e?.response?.data?.message || '编辑权已失效，当前为只读'); }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [drainSaves, id, lease?.epoch]);

  useEffect(() => () => {
    const current = leaseRef.current;
    if (id && current) void fetch(`/api/canvas/${id}/control/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseToken: current.leaseToken, leaseEpoch: current.epoch }), keepalive: true });
  }, [id]);

  const requestControl = useCallback(async () => {
    if (!id) return;
    try {
      const status = await request<{ status: string }>(`/api/canvas/${id}/control/status`);
      if (!['available', 'expired', 'revoked'].includes(status.status)) {
        await request<{ status: string }>(`/api/canvas/${id}/control/request-handoff`, { method: 'POST', data: { holderType: 'human', holderId: humanHolderId() } });
      }
      setHandoffRequested(true);
      setControlMessage(['available', 'expired', 'revoked'].includes(status.status) ? '正在取得编辑权…' : '已请求交接，等待当前控制者保存并释放…');
    } catch (e: any) { message.error(e?.response?.data?.message || '请求交接失败'); }
  }, [id]);

  useEffect(() => {
    if (!id || lease) return;
    const checkControl = async () => {
      try {
        const status = await request<any>(`/api/canvas/${id}/control/status`);
        const available = ['available', 'expired', 'revoked'].includes(status.status);
        const activeHolder = !available && status?.lease ? { holderType: status.lease.holderType, holderId: status.lease.holderId, status: status.status } : null;
        setObservedHolder(activeHolder);
        if (!handoffRequested) setControlMessage(activeHolder ? `由${activeHolder.holderType === 'agent' ? 'AI' : '人工'}持有，当前为只读` : '当前没有控制者，可主动取得编辑权');
        if (!handoffRequested || !available) return;
        const acquired = await request<CanvasLease>(`/api/canvas/${id}/control/acquire`, { method: 'POST', data: { holderType: 'human', holderId: humanHolderId() } });
        const latest = await request<CanvasDoc>(`/api/canvas/${id}`);
        const runHistory = await request<{ items: GenerationRunItem[] }>(`/api/runs?canvasId=${encodeURIComponent(id)}&pageSize=1`);
        const handedRun = runHistory.items?.find((run) => run.latestHandoff?.outcome === 'released');
        if (handedRun) await request(`/api/runs/${handedRun.id}/adopt`, { method: 'POST', data: {
          leaseToken: acquired.leaseToken, leaseEpoch: acquired.epoch, expectedRevision: latest.revision,
          actorType: 'human', actorId: humanHolderId(),
        } });
        revisionRef.current = latest.revision; setDoc(latest); setLease(acquired); setObservedHolder(null); setHandoffRequested(false); setControlMessage('');
        setSaveStatus('saved'); setLastSavedAt(new Date(latest.updatedAt)); setSaveError('');
      } catch { /* 竞争失败或尚未释放，继续等待 */ }
    };
    void checkControl();
    const timer = window.setInterval(() => void checkControl(), 2000);
    return () => window.clearInterval(timer);
  }, [handoffRequested, id, lease]);

  /**
   * 只读观察者自动跟随 canonical graph；所有控制者持续读取共享 ComfyUI 运行态。
   */
  useEffect(() => {
    if (!id || !ready) return;
    let cancelled = false;
    const syncReadOnlyState = async () => {
      try {
        const latest = await request<CanvasDoc>(`/api/canvas/${id}`);
        if (!cancelled && !leaseRef.current && latest.revision > revisionRef.current && !pendingSaveRef.current && !saveInFlightRef.current) {
          revisionRef.current = latest.revision;
          setDoc(latest);
          setSaveStatus('saved');
          setLastSavedAt(new Date(latest.updatedAt));
          setSaveError('');
        }
      } catch { /* 短暂断线时保留当前画布，下次轮询继续同步。 */ }

      try {
        const [payload, persistent] = await Promise.all([
          request<{ runs: CanvasRunState[] }>('/api/comfyui/runs'),
          request<{ items: GenerationRunItem[] }>(`/api/runs?canvasId=${encodeURIComponent(id)}&pageSize=100`),
        ]);
        if (cancelled) return;
        const latestByNode = new Map<string, CanvasRunState>();
        for (const run of payload.runs ?? []) {
          if (run.canvasId === id && run.nodeId && !latestByNode.has(run.nodeId)) latestByNode.set(run.nodeId, run);
        }
        for (const run of persistent.items ?? []) {
          if (run.provider !== 'codex2api' || !run.nodeId || !['queued', 'running'].includes(run.status) || latestByNode.has(run.nodeId)) continue;
          latestByNode.set(run.nodeId, {
            promptId: run.id,
            title: run.capabilityId || 'Codex2API',
            status: run.status === 'queued' ? 'pending' : 'running',
            queuedAt: run.queuedAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            nodes: {}, nodeTitles: {}, outputs: [], nodeErrors: {},
          });
        }
        setNodeRuns((previous) => {
          const next = { ...previous };
          for (const [nodeId, run] of latestByNode) next[nodeId] = run;
          for (const [nodeId, run] of Object.entries(next)) {
            if (run && ['pending', 'running'].includes(run.status) && !latestByNode.has(nodeId)) next[nodeId] = null;
          }
          return next;
        });
      } catch { /* 运行态服务不可用不影响画布 revision 同步。 */ }
    };
    void syncReadOnlyState();
    const timer = window.setInterval(() => void syncReadOnlyState(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canWrite, id, ready]);

  /** 节点、连线或视口变化后 800ms 防抖保存。 */
  useEffect(() => {
    if (!ready || !id || !canWrite) return;
    const graph = createPersistedGraph(nodes, edges, viewport);
    const snapshot = JSON.stringify(graph);
    if (snapshot === lastSavedSnapshotRef.current) return;
    pendingSaveRef.current = { graph, snapshot };
    setSaveStatus('dirty');
    setSaveError('');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), 800);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [canWrite, edges, flushSave, id, nodes, ready, viewport]);

  // 离开编辑器时尽力提交最后一版（常规路由跳转可完成；浏览器强退不作同步阻塞）。
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void flushSave();
  }, [flushSave]);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!pendingSaveRef.current && !saveInFlightRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnUnsaved);
    return () => window.removeEventListener('beforeunload', warnUnsaved);
  }, []);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      manualSave();
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [manualSave]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(canWrite ? changes : changes.filter((change) => change.type === 'select' || change.type === 'dimensions'), nds)),
    [canWrite],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(canWrite ? changes : changes.filter((change) => change.type === 'select'), eds)),
    [canWrite],
  );

  /** 删除指定连线；供工具按钮和双击手势共用。 */
  const deleteEdge = useCallback((edgeId: string) => {
    if (!canWrite) return;
    setEdges((eds) => eds.filter((edge) => edge.id !== edgeId));
  }, [canWrite]);

  /** 连线校验：媒体类型必须一致；结果端点或工作流声明的同类型输入。 */
  const isValidConnection: IsValidConnection = useCallback((conn) => {
    const s = conn.sourceHandle ?? '';
    const t = conn.targetHandle ?? '';
    const sourceKind = sourceHandleKind(s);
    if (!sourceKind) return false;
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    // 若目标节点沿已有出边已经能到达源节点，再添加 source → target 会形成环路。
    const visited = new Set<string>();
    const reachesSource = (nodeId: string): boolean => {
      if (nodeId === conn.source) return true;
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      return edgesRef.current
        .filter((edge) => edge.source === nodeId)
        .some((edge) => reachesSource(edge.target));
    };
    if (reachesSource(conn.target)) return false;
    if (t.endsWith('-target')) return t === `${sourceKind}-target`;
    if (!t.startsWith('input:')) return false;
    const targetNode = nodesRef.current.find((node) => node.id === conn.target);
    const workflowId = (targetNode?.data as any)?.workflowId;
    if (!workflowId) return false;
    // 图片端点沿用历史格式 input:<node>:<param>；新增类型显式写入 input:<kind>:...。
    const targetKind = t.startsWith('input:text:') ? 'text'
      : t.startsWith('input:video:') ? 'video'
        : t.startsWith('input:audio:') ? 'audio'
          : 'image';
    return sourceKind === targetKind;
  }, []);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!canWrite) return;
      pendingConnectionRef.current = null;
      // 一个输入字段只能有一个来源；新连线替换该端口原有入线。
      setEdges((eds) => addEdge(conn, eds.filter((edge) =>
        !(edge.target === conn.target && edge.targetHandle === conn.targetHandle),
      )));
    },
    [canWrite],
  );

  const pendingConnectionRef = useRef<{
    sourceNodeId: string;
    sourceHandle: string;
    kind: 'image' | 'video' | 'audio' | 'text';
    touchStart?: { x: number; y: number };
  } | null>(null);

  const onConnectStart: OnConnectStart = useCallback((event, params) => {
    if (params.handleType !== 'source' || !params.nodeId || !params.handleId) {
      pendingConnectionRef.current = null;
      return;
    }
    const kind = sourceHandleKind(params.handleId);
    const touch = 'touches' in event && event.touches.length ? event.touches[0] : null;
    pendingConnectionRef.current = ['image', 'video', 'audio', 'text'].includes(kind)
      ? {
        sourceNodeId: params.nodeId,
        sourceHandle: params.handleId,
        kind: kind as 'image' | 'video' | 'audio' | 'text',
        touchStart: touch ? { x: touch.clientX, y: touch.clientY } : undefined,
      }
      : null;
  }, []);

  const setMiniMapVisibility = useCallback((open: boolean) => {
    setMiniMapOpen(open);
    window.localStorage.setItem('carrot-canvas:minimap-open', String(open));
  }, []);

  /** 输出端点拖到画布空白处：打开只包含兼容输入工作流的创建菜单。 */
  const onConnectEnd: OnConnectEnd = useCallback((event, connectionState) => {
    const pending = pendingConnectionRef.current;
    pendingConnectionRef.current = null;
    if (connectionState.isValid || !pending) return;
    const point = 'changedTouches' in event && event.changedTouches.length
      ? event.changedTouches[0]
      : event as MouseEvent;
    // React Flow 支持“点一下源端点，再点一下目标端点”。触屏轻点时同样会经历
    // connect start/end；这里不能把它误判为“拖到空白处”，否则创建菜单会盖住第二次点按。
    if (pending.touchStart) {
      const dx = point.clientX - pending.touchStart.x;
      const dy = point.clientY - pending.touchStart.y;
      if (dx * dx + dy * dy < 144) return;
    }
    setMenu({
      screenX: point.clientX,
      screenY: point.clientY,
      connection: {
        ...pending,
      },
    });
  }, []);

  /** 节点 data 变更统一回写受控 state（自定义节点经 Context 调用） */
  const handleUpdateNodeData = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    if (!canWrite) return;
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
  }, [canWrite]);

  /** 删除节点 + 其相连边（自定义节点经 Context 调用，二次确认在节点内） */
  const handleDeleteNode = useCallback(async (nodeId: string) => {
    if (!canWrite) return;
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setNodeRuns((runs) => {
      if (!(nodeId in runs)) return runs;
      const next = { ...runs };
      delete next[nodeId];
      return next;
    });
  }, [canWrite]);

  const ensureResultNode = useCallback((sourceNodeId: string, kind: 'image' | 'video' = 'image') => {
    if (!canWrite) return;
    const sourceHandle = resultSourceHandle(kind);
    const targetHandle = resultTargetHandle(kind);
    const alreadyConnected = edgesRef.current.some((edge) =>
      edge.source === sourceNodeId && edge.sourceHandle === sourceHandle &&
      nodesRef.current.some((node) => node.id === edge.target && node.type === NODE_TYPE_RESULT),
    );
    if (alreadyConnected) return;
    const source = nodesRef.current.find((node) => node.id === sourceNodeId);
    if (!source) return;
    const result = createResultNode({
      x: source.position.x + CANVAS_NODE_WIDTH + 80,
      y: source.position.y,
    }, kind);
    const edge: Edge = {
      id: `edge-${sourceNodeId}-${result.id}`,
      source: sourceNodeId,
      sourceHandle,
      target: result.id,
      targetHandle,
    };
    setNodes((nds) => [...nds, result]);
    setEdges((eds) => [...eds, edge]);
  }, [canWrite]);

  const setNodeRunState = useCallback((nodeId: string, run: RunStateData | null) => {
    setNodeRuns((prev) => ({ ...prev, [nodeId]: run }));
  }, [canWrite]);

  const getNodeRunState = useCallback((nodeId: string) => nodeRuns[nodeId] ?? null, [nodeRuns]);

  const getResultState = useCallback((resultNodeId: string): CanvasResultState => {
    const resultNode = nodes.find((item) => item.id === resultNodeId);
    const kind = (resultNode?.data as any)?.kind === 'video' ? 'video' : 'image';
    const targetHandle = resultTargetHandle(kind);
    const edge = edges.find((item) => item.target === resultNodeId && item.targetHandle === targetHandle);
    if (!edge) return { run: null, assets: [] };
    let source = nodes.find((item) => item.id === edge.source);
    if (source?.type === NODE_TYPE_RESULT) {
      const upstreamKind = (source.data as any)?.kind === 'video' ? 'video' : 'image';
      const resultInput = edges.find((item) => item.target === source!.id && item.targetHandle === resultTargetHandle(upstreamKind));
      source = resultInput ? nodes.find((item) => item.id === resultInput.source) : undefined;
    }
    const assets = ((source?.data as any)?.lastAssets ?? []) as CanvasResultState['assets'];
    return { run: nodeRuns[edge.source] ?? null, assets };
  }, [edges, nodes, nodeRuns]);

  const getUpstreamAsset = useCallback((targetNodeId: string, targetHandle: string, kind: string) => {
    const edge = edges.find((item) => item.target === targetNodeId && item.targetHandle === targetHandle);
    if (!edge) return null;
    let source = nodes.find((item) => item.id === edge.source);
    if (source?.type === NODE_TYPE_RESULT) {
      const upstreamKind = (source.data as any)?.kind === 'video' ? 'video' : 'image';
      const resultInput = edges.find((item) => item.target === source!.id && item.targetHandle === resultTargetHandle(upstreamKind));
      source = resultInput ? nodes.find((item) => item.id === resultInput.source) : undefined;
    }
    const assets = ((source?.data as any)?.lastAssets ?? []) as CanvasResultState['assets'];
    return assets.find((asset) => asset.kind === kind) ?? null;
  }, [edges, nodes]);

  const getUpstreamText = useCallback((targetNodeId: string, targetHandle: string) => {
    const edge = edges.find((item) => item.target === targetNodeId && item.targetHandle === targetHandle);
    if (!edge) return { connected: false, text: '' };
    const source = nodes.find((item) => item.id === edge.source);
    const sourceData = (source?.data ?? {}) as any;
    const part = edge.sourceHandle === 'text-positive-source' ? 'positive' : edge.sourceHandle === 'text-negative-source' ? 'negative' : null;
    return { connected: true, text: String(part ? sourceData.lastTextParts?.[part] ?? '' : sourceData.lastText ?? '') };
  }, [edges, nodes]);

  const handleMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
    setViewport(nextViewport);
    if (id) window.localStorage.setItem(`carrot-canvas:viewport:${id}`, JSON.stringify(nextViewport));
  }, [id]);

  const { screenToFlowPosition } = useReactFlow();

  /** 在屏幕坐标处打开分级菜单（右键 / 移动端长按共用） */
  const openMenu = useCallback((screenX: number, screenY: number) => {
    setMenu({ screenX, screenY });
  }, []);

  /** 画布空白右键 → 打开分级菜单（记录右键屏幕坐标） */
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      openMenu((event as MouseEvent).clientX, (event as MouseEvent).clientY);
    },
    [openMenu],
  );

  // ── 移动端长按 = 右键替代（能用即可）──
  // 用原生 touch 监听（挂到容器 DOM，capture 阶段，先于 React Flow 的平移手势拿到事件），
  // 单指按住 ~450ms 且移动 < 16px 判定为长按 → 打开菜单；移动过多/多指/提前抬手则取消。
  // 长按打开后短时抑制随之而来的合成 click，避免菜单被“外部点击关闭”立刻关掉。
  const suppressClickRef = useRef(false);
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      start = null;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        clear();
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!start) return;
        suppressClickRef.current = true;
        openMenuRef.current(start.x, start.y);
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 600);
        clear();
      }, 450);
    };

    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) {
        clear();
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (dx * dx + dy * dy > 256) clear(); // 移动 > 16px 视为平移，取消
    };

    // capture:true 让容器先于内部（React Flow pane）拿到事件；passive:true 不阻止默认滚动/缩放
    el.addEventListener('touchstart', onStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onMove, { capture: true, passive: true });
    el.addEventListener('touchend', clear, { capture: true, passive: true });
    el.addEventListener('touchcancel', clear, { capture: true, passive: true });
    return () => {
      clear();
      el.removeEventListener('touchstart', onStart, { capture: true } as any);
      el.removeEventListener('touchmove', onMove, { capture: true } as any);
      el.removeEventListener('touchend', clear, { capture: true } as any);
      el.removeEventListener('touchcancel', clear, { capture: true } as any);
    };
  }, [ready]);

  // 长按打开菜单后，抑制紧随的合成 click（捕获阶段拦下）
  const onContainerClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      e.stopPropagation();
      e.preventDefault();
      suppressClickRef.current = false;
    }
  }, []);

  /** 菜单选中工作流 → 在右键处（转 flow 坐标为节点左上角）落生成节点（§4.2.1） */
  const handlePickWorkflow = useCallback(
    (wf: ComfyUIAPI) => {
      if (!canWrite) return;
      let pos = { x: 0, y: 0 };
      try {
        pos = menu ? screenToFlowPosition({ x: menu.screenX, y: menu.screenY }) : { x: 0, y: 0 };
      } catch {
        // screenToFlowPosition 未就绪时兜底到画布原点，不阻塞落节点
      }
      const node = createTxt2ImgNode(pos, { id: wf.id, name: wf.name });
      setNodes((nds) => [...nds, node]);
      if (menu?.connection) {
        const input = wf.inputConfig?.fields?.find((field) => field.kind === menu.connection!.kind);
        if (input) {
          const edge: Edge = {
            id: `edge-${menu.connection.sourceNodeId}-${node.id}-${input.nodeId}-${input.param}`,
            source: menu.connection.sourceNodeId,
            sourceHandle: menu.connection.sourceHandle,
            target: node.id,
            targetHandle: workflowInputHandle(input.nodeId, input.param, input.kind),
          };
          setEdges((eds) => [...eds, edge]);
        }
      }
      setMenu(null);
    },
    [canWrite, menu, screenToFlowPosition],
  );

  const handlePickCapability = useCallback((capability: CodexCapability) => {
    if (!canWrite) return;
    let pos = { x: 0, y: 0 };
    try { pos = menu ? screenToFlowPosition({ x: menu.screenX, y: menu.screenY }) : pos; } catch { /* 画布尚未就绪时落在原点 */ }
    const node = createCodexCapabilityNode(pos, capability);
    setNodes((items) => [...items, node]);
    if (menu?.connection) {
      const targetHandle = menu.connection.kind === 'text'
        ? capabilityPromptHandle()
        : resultTargetHandle(menu.connection.kind);
      const edge: Edge = {
        id: `edge-${menu.connection.sourceNodeId}-${node.id}-${targetHandle}`,
        source: menu.connection.sourceNodeId,
        sourceHandle: menu.connection.sourceHandle,
        target: node.id,
        targetHandle,
      };
      setEdges((items) => [...items, edge]);
    }
    setMenu(null);
  }, [canWrite, menu, screenToFlowPosition]);

  const nodeCount = nodes.length;
  const selectedEdge = edges.find((edge) => edge.selected);
  const saveTag = useMemo(() => {
    switch (saveStatus) {
      case 'dirty': return { text: '有未保存更改', title: '修改将在短暂延迟后自动保存' };
      case 'saving': return { text: '保存中…', title: '正在保存画布内容' };
      case 'saved': return {
        text: `已保存${lastSavedAt ? ` · ${lastSavedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`,
        title: lastSavedAt ? `最后保存于 ${lastSavedAt.toLocaleString('zh-CN', { hour12: false })}` : '画布内容已保存',
      };
      case 'error': return { text: '保存失败 · 点击重试', title: saveError || '点击重试保存' };
      default: return null;
    }
  }, [lastSavedAt, saveError, saveStatus]);
  const visibleHolder = lease ?? observedHolder;
  const controlTone = canWrite ? 'editable' : handoffRequested || visibleHolder?.status === 'handoff_pending' ? 'handoff' : 'readonly';
  const controlLabel = canWrite
    ? `${lease?.holderType === 'agent' ? 'AI' : '人工'} · 可编辑`
    : handoffRequested
      ? visibleHolder ? `${visibleHolder.holderType === 'agent' ? 'AI' : '人工'} · 等待交接` : '正在取得编辑权'
      : `${visibleHolder?.holderType === 'agent' ? 'AI' : visibleHolder?.holderType === 'human' ? '人工' : '无控制者'} · 只读`;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
        ...(isNarrow
          ? {
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              padding: 0,
              background: '#fff',
              // 高于 ProLayout，但低于 Ant Design Popconfirm（默认 1030）。
              zIndex: 1000,
            }
          : {
              height: rootHeight != null ? rootHeight : 'calc(100dvh - 56px)',
              padding: 0,
            }),
      }}
    >
      {/* 画布主体 */}
      <div
        ref={containerRef}
        onContextMenu={onPaneContextMenu}
        onClickCapture={onContainerClickCapture}
        style={{
          flex: 1,
          position: 'relative',
          border: 0,
          borderRadius: 0,
          overflow: 'hidden',
          // 抑制 iOS 长按的文字选择/放大镜；平移缩放交给 React Flow
          WebkitUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Spin size="large" tip="加载画布中…" />
          </div>
        ) : loadError ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text type="danger">{loadError}</Text>
          </div>
        ) : doc && ready ? (
          <CanvasNodeDataContext.Provider value={{
            canvasId: id,
            readOnly: !canWrite,
            control: lease ? { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch, expectedRevision: revisionRef.current } : undefined,
            updateNodeData: handleUpdateNodeData,
            deleteNode: handleDeleteNode,
            ensureResultNode,
            setNodeRunState,
            getNodeRunState,
            getResultState,
            getUpstreamAsset,
            getUpstreamText,
          }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodesDraggable={canWrite}
              nodesConnectable={canWrite}
              elementsSelectable
              panOnDrag={effectiveInteractionMode === 'hand'}
              selectionOnDrag={effectiveInteractionMode === 'pointer'}
              selectionMode={SelectionMode.Partial}
              onPaneClick={() => {
                if (effectiveInteractionMode !== 'pointer') return;
                setNodes((items) => items.map((node) => node.selected ? { ...node, selected: false } : node));
                setEdges((items) => items.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onEdgeDoubleClick={(_event, edge) => deleteEdge(edge.id)}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              connectOnClick
              isValidConnection={isValidConnection}
              nodeTypes={canvasNodeTypes}
              defaultViewport={viewport ?? undefined}
              fitView={!viewport}
              onMoveEnd={handleMoveEnd}
              deleteKeyCode={canWrite ? ['Backspace', 'Delete'] : null}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Panel position="bottom-center" className="canvas-interaction-mode nodrag">
                <Segmented
                  value={interactionMode}
                  onChange={(value) => { setSpacePanActive(false); setInteractionMode(value as 'hand' | 'pointer'); }}
                  options={[
                    { value: 'hand', label: <Tooltip title="手掌模式：拖动空白处平移画布"><span aria-label="手掌模式"><DragOutlined />{isNarrow ? null : ' 手掌'}</span></Tooltip> },
                    { value: 'pointer', label: <Tooltip title="指针模式：拖动空白处框选卡片，按住空格临时平移"><span aria-label="鼠标指针模式"><SelectOutlined />{isNarrow ? null : ' 指针'}</span></Tooltip> },
                  ]}
                  aria-label="画布交互模式"
                />
              </Panel>
              <Panel position="top-left" className="canvas-floating-header">
                <Link to="/canvas">
                  <Button icon={<ArrowLeftOutlined />} aria-label="返回画布列表">{isNarrow ? null : '返回列表'}</Button>
                </Link>
                <div className={`canvas-save-panel is-${canWrite ? saveStatus : 'readonly'}`} title={canWrite ? saveTag?.title : '当前会话没有画布编辑权'}>
                  <span className="canvas-save-status">
                    {canWrite ? (saveTag?.text ?? '准备保存') : '只读'}
                  </span>
                  <Button
                    type="text"
                    size="small"
                    icon={<SaveOutlined />}
                    disabled={!canWrite || saveStatus === 'saving'}
                    loading={saveStatus === 'saving'}
                    aria-label="立即保存画布"
                    onClick={() => manualSave()}
                  >
                    {isNarrow ? null : '保存'}
                  </Button>
                </div>
                {doc ? (
                  <div
                    className={`canvas-floating-title${editingName ? ' is-editing' : ''}`}
                    title={editingName ? undefined : `${canvasName}（双击重命名）`}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      if (canWrite && !editingName) startRename();
                    }}
                  >
                    {editingName ? (
                      <Input
                        className="canvas-title-input nodrag nowheel"
                        value={nameDraft}
                        maxLength={60}
                        autoFocus
                        disabled={renaming}
                        aria-label="画布名称"
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onPressEnter={(event) => event.currentTarget.blur()}
                        onBlur={() => {
                          if (cancelNameBlurRef.current) {
                            cancelNameBlurRef.current = false;
                            return;
                          }
                          void submitRename();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') cancelRename();
                        }}
                      />
                    ) : <span>{canvasName}</span>}
                  </div>
                ) : null}
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  content={(
                    <div className="canvas-control-detail">
                      <div><strong>{canWrite ? '画布可编辑' : '画布只读'}</strong></div>
                      <div>类型：{visibleHolder?.holderType === 'agent' ? 'AI' : visibleHolder?.holderType === 'human' ? '人工' : '无'}</div>
                      <div className="canvas-control-holder-id">ID：{visibleHolder?.holderId ?? '暂无控制者'}</div>
                      <div>状态：{visibleHolder?.status ?? (canWrite ? 'active' : 'available')}</div>
                      <div>revision：{revisionRef.current}</div>
                      {controlMessage ? <div className="canvas-control-note">{controlMessage}</div> : null}
                      {!canWrite && !handoffRequested ? <Button size="small" onClick={() => void requestControl()}>{visibleHolder ? '请求交接' : '取得编辑权'}</Button> : null}
                    </div>
                  )}
                >
                  <button type="button" className={`canvas-control-chip is-${controlTone}`} aria-label="查看画布控制权详情">
                    {controlLabel}
                  </button>
                </Popover>
                <Button icon={<HistoryOutlined />} onClick={() => { setHistoryOpen(true); void loadHistory(); }} aria-label="操作历史与恢复点">
                  {isNarrow ? null : '历史'}
                </Button>
                <Button icon={<PictureOutlined />} onClick={() => { setGenerationHistoryOpen(true); void loadGenerationHistory(); }} aria-label="画布生成流水">
                  {isNarrow ? null : '生成历史'}
                </Button>
              </Panel>
              {selectedEdge ? (
                <Panel position="top-right" className="canvas-edge-actions">
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="删除选中的连线"
                    onClick={() => deleteEdge(selectedEdge.id)}
                  >
                    {isNarrow ? null : '删除连线'}
                  </Button>
                </Panel>
              ) : null}
              {miniMapOpen ? (
                <Panel position="bottom-right" className="canvas-minimap-panel" onDoubleClickCapture={() => setMiniMapVisibility(false)}>
                  <MiniMap pannable zoomable />
                </Panel>
              ) : (
                <Panel position="bottom-right" className="canvas-minimap-toggle">
                  <Button shape="circle" icon={<EnvironmentOutlined />} aria-label="打开缩略图" onClick={() => setMiniMapVisibility(true)} />
                </Panel>
              )}
              <Controls />
            </ReactFlow>

            {canWrite ? <CanvasContextMenu state={menu} onClose={() => setMenu(null)} onPick={handlePickWorkflow} onPickCapability={handlePickCapability} /> : null}

            {/* 空白画布提示 */}
            {nodeCount === 0 ? (
              <div
                style={{
                  position: 'absolute',
                  top: 64,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  background: 'rgba(255,255,255,0.9)',
                  borderRadius: 8,
                  padding: '8px 16px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
              >
                <Text type="secondary">
                  {isNarrow
                    ? '空白画布 · 长按选择 AI 能力或 ComfyUI 工作流'
                    : '空白画布 · 右键选择 AI 能力或 ComfyUI 工作流'}
                </Text>
              </div>
            ) : null}
          </CanvasNodeDataContext.Provider>
        ) : null}
      </div>
      <Drawer title="操作历史与恢复点" open={historyOpen} onClose={() => setHistoryOpen(false)} width={isNarrow ? '100%' : 520}>
        <Spin spinning={historyLoading}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Title level={5} style={{ margin: 0 }}>恢复点</Typography.Title>
                <Button type="primary" disabled={!canWrite} onClick={() => void createCheckpoint()}>创建当前恢复点</Button>
              </Space>
              <List
                size="small"
                locale={{ emptyText: '暂无恢复点' }}
                dataSource={checkpoints}
                renderItem={(item) => <List.Item actions={[<Popconfirm key="restore" title="覆盖恢复画布？" description="当前状态会作为一条可审计操作被替换。" okText="确认恢复" cancelText="取消" onConfirm={() => void restoreCheckpoint(item.id)}><Button size="small" danger disabled={!canWrite}>恢复</Button></Popconfirm>]}>
                  <List.Item.Meta title={`${item.name} · revision ${item.revision}`} description={`${item.createdByType === 'agent' ? 'AI' : '人工'} ${item.createdById} · ${new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}`} />
                </List.Item>}
              />
            </div>
            <div>
              <Typography.Title level={5}>操作批次</Typography.Title>
              <List
                size="small"
                locale={{ emptyText: '暂无操作记录' }}
                dataSource={operationLogs}
                renderItem={(item) => <List.Item actions={[<Popconfirm key="undo" title="撤销这个操作批次？" description="只有它仍是画布最新修改时才能安全撤销。" okText="撤销" cancelText="取消" onConfirm={() => void undoLog(item.id)}><Button size="small" disabled={!canWrite || !!item.undoneByLogId || item.resultRevision !== revisionRef.current}>撤销</Button></Popconfirm>]}>
                  <List.Item.Meta
                    title={<Space><span>revision {item.baseRevision} → {item.resultRevision}</span>{item.undoneByLogId ? <Tag>已撤销</Tag> : null}</Space>}
                    description={<><div>{item.intent || item.operations.map((operation) => operation.type).join('、')}</div><div>{item.actorType === 'agent' ? 'AI' : '人工'} {item.actorId} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</div></>}
                  />
                </List.Item>}
              />
            </div>
          </Space>
        </Spin>
      </Drawer>
      <Drawer title="画布生成流水" open={generationHistoryOpen} onClose={() => setGenerationHistoryOpen(false)} width={isNarrow ? '100%' : 620}>
        <Spin spinning={generationHistoryLoading}>
          <List dataSource={generationRuns} locale={{ emptyText: '还没有生成记录' }} renderItem={(run) => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <Space wrap><Tag color={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'error' : run.status === 'needs_attention' ? 'warning' : 'processing'}>{run.status}</Tag><Tag>{run.provider}</Tag>{run.latestHandoff ? <Tag color={run.latestHandoff.outcome === 'adopted' ? 'blue' : run.latestHandoff.outcome === 'released' ? 'gold' : 'error'}>{run.latestHandoff.outcome === 'adopted' ? `${run.latestHandoff.toActorType === 'agent' ? 'AI' : '人工'}已接手` : run.latestHandoff.outcome === 'released' ? '等待接手' : '交接失败'}</Tag> : null}<RunDuration timestamps={run} /><Text type="secondary">尝试 {run.attemptCount}</Text><Text type="secondary">{new Date(run.createdAt).toLocaleString()}</Text></Space>
                <div style={{ marginTop: 6 }}><Text>节点：{run.nodeId ?? '工具箱'} · 能力：{run.capabilityId ?? '-'}</Text></div>
                {run.error?.message ? <div style={{ color: '#ff4d4f', marginTop: 4 }}>{run.error.message}</div> : null}
                {run.outputText ? <Typography.Paragraph style={{ marginTop: 10, whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 4, expandable: true, symbol: '展开全文' }}>{run.outputText}</Typography.Paragraph> : null}
                {run.outputAssetIds.length ? <Image.PreviewGroup><Space wrap style={{ marginTop: 10 }}>{run.outputAssetIds.map((assetId) => <div key={assetId} style={{ width: 112 }}><Image src={`/api/assets/${assetId}`} alt="生成产物" width={112} height={84} style={{ objectFit: 'cover', borderRadius: 6 }} preview={{ mask: '放大预览' }} /><Button size="small" icon={<DownloadOutlined />} href={`/api/assets/${assetId}/download`} download onClick={(event) => event.stopPropagation()} style={{ marginTop: 4 }}>下载</Button></div>)}</Space></Image.PreviewGroup> : null}
              </div>
            </List.Item>
          )} />
        </Spin>
      </Drawer>
    </div>
  );
}
