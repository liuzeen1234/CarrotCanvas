import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  ReactFlowProvider,
  useReactFlow,
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
import { Button, Spin, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Link, useParams, request } from 'umi';
import { CanvasNodeDataContext, type CanvasResultState } from '@/components/canvas/context';
import { canvasNodeTypes } from '@/components/canvas/nodes';
import { HANDLE_IMAGE_TARGET, NODE_TYPE_RESULT, NODE_TYPE_TXT2IMG, CANVAS_NODE_WIDTH, createResultNode, createTxt2ImgNode, resultSourceHandle, resultTargetHandle } from '@/components/canvas/nodes/types';
import CanvasContextMenu, { type CanvasContextMenuState } from '@/components/canvas/CanvasContextMenu';
import { ComfyUIAPI, type RunStateData } from '@/components/comfyui/types';

const { Title, Text } = Typography;

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
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** 只持久化可恢复的 React Flow 数据，剔除选中/拖动/尺寸测量等瞬时 UI 状态。 */
function createPersistedGraph(nodes: Node[], edges: Edge[], viewport: Viewport | null) {
  return {
    version: 1,
    nodes: nodes.map(({ selected: _selected, dragging: _dragging, measured: _measured, ...node }) => node),
    edges: edges.map(({ selected: _selected, ...edge }) => edge),
    viewport,
  };
}

/** ISO 时间 → YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** doc 已就绪且 nodes/edges 已初始化（避免先渲染一帧空图） */
  const [ready, setReady] = useState(false);

  // 受控节点图：C5 编辑器内可添加/删除/连线；自动保存由 C7 落地
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
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

  /** 右键分级菜单状态（右键屏幕坐标；null = 关闭） */
  const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);

  /** 窄屏（移动端）标志：切换顶栏/内边距布局，避免被挤成竖排 */
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  /** 编辑器根容器：测量它距视口顶部的真实偏移。
      - 桌面（非窄屏）：用它精确算高度，避免猜 ProLayout header 高度留白/溢出。
      - 窄屏：用它作为 fixed 定位的 top，容器随后 fixed 铺满到 bottom:0。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  /** 窄屏 fixed 定位用的顶部偏移；一旦 fixed，getBoundingClientRect().top 会等于它本身，
      故只在“尚未 fixed”时更新，避免自锁 */
  const [rootTop, setRootTop] = useState<number | null>(null);
  const fixedLockedRef = useRef(false);

  useEffect(() => {
    const recompute = () => {
      const narrow = window.innerWidth < 768;
      setIsNarrow(narrow);
      const el = rootRef.current;
      if (!el) return;
      if (narrow) {
        if (!fixedLockedRef.current) {
          // 尚未 fixed：此刻 top 是文档流中的真实偏移，锁定它
          const top = el.getBoundingClientRect().top;
          setRootTop(top);
          fixedLockedRef.current = true;
        }
      } else {
        // 回到桌面：解除锁定，按高度计算
        fixedLockedRef.current = false;
        const top = el.getBoundingClientRect().top;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        setRootHeight(Math.max(240, Math.floor(vh - top)));
        setRootTop(null);
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
    if (!id) return;
    // 切换画布时重置状态，避免残留上一张画的节点
    setDoc(null);
    setReady(false);
    setNodes([]);
    setEdges([]);
    setViewport(null);
    setSaveStatus('idle');
    setSavedAt(null);
    setLoading(true);
    setLoadError(null);
    request<CanvasDoc>(`/api/canvas/${id}`)
      .then((data) => setDoc(data))
      .catch((e: any) => {
        setLoadError(e?.response?.data?.message || '加载画布失败');
        setDoc(null);
      })
      .finally(() => setLoading(false));
  }, [id]);

  // doc 就绪 → 用持久化 graph 初始化受控节点图
  useEffect(() => {
    if (!doc) return;
    const initialNodes = doc.graph?.nodes ?? [];
    const initialEdges = doc.graph?.edges ?? [];
    const initialViewport = doc.graph?.viewport ?? null;
    setNodes(initialNodes);
    setEdges(initialEdges);
    setViewport(initialViewport);
    setSavedAt(doc.updatedAt);
    lastSavedSnapshotRef.current = JSON.stringify(createPersistedGraph(initialNodes, initialEdges, initialViewport));
    setReady(true);
  }, [doc]);

  /** 串行写入最新 graph；保存期间继续变化时，完成后立刻追写最新版本，避免旧请求覆盖新状态。 */
  const flushSave = useCallback(async () => {
    if (!id || saveInFlightRef.current || !pendingSaveRef.current) return;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    saveInFlightRef.current = true;
    setSaveStatus('saving');
    try {
      const saved = await request<CanvasDoc>(`/api/canvas/${id}`, { method: 'PATCH', data: { graph: pending.graph } });
      lastSavedSnapshotRef.current = pending.snapshot;
      setSavedAt(saved.updatedAt);
      setSaveStatus(pendingSaveRef.current ? 'dirty' : 'saved');
    } catch (error: any) {
      pendingSaveRef.current = pendingSaveRef.current ?? pending;
      setSaveStatus('error');
      message.error(error?.response?.data?.message || '画布自动保存失败');
    } finally {
      saveInFlightRef.current = false;
      if (pendingSaveRef.current && pendingSaveRef.current.snapshot !== lastSavedSnapshotRef.current) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => void flushSave(), 0);
      }
    }
  }, [id]);

  /** 节点、连线或视口变化后 800ms 防抖保存。 */
  useEffect(() => {
    if (!ready || !id) return;
    const graph = createPersistedGraph(nodes, edges, viewport);
    const snapshot = JSON.stringify(graph);
    if (snapshot === lastSavedSnapshotRef.current) return;
    pendingSaveRef.current = { graph, snapshot };
    setSaveStatus('dirty');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), 800);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [edges, flushSave, id, nodes, ready, viewport]);

  // 离开编辑器时尽力提交最后一版（常规路由跳转可完成；浏览器强退不作同步阻塞）。
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void flushSave();
  }, [flushSave]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  /** 连线校验：媒体类型必须一致；结果端点或工作流声明的同类型输入。 */
  const isValidConnection: IsValidConnection = useCallback((conn) => {
    const s = conn.sourceHandle ?? '';
    const t = conn.targetHandle ?? '';
    const sourceKind = s.endsWith('-source') ? s.slice(0, -7) : '';
    if (!sourceKind) return false;
    if (t.endsWith('-target')) return t === `${sourceKind}-target`;
    if (!t.startsWith('input:')) return false;
    const targetNode = nodesRef.current.find((node) => node.id === conn.target);
    const workflowId = (targetNode?.data as any)?.workflowId;
    // 工作流字段的精确类型还会在运行时校验；当前已开放的可连接字段为 image。
    return sourceKind === 'image' && !!workflowId;
  }, []);

  const onConnect = useCallback(
    (conn: Connection) => {
      pendingConnectionRef.current = null;
      setEdges((eds) => addEdge(conn, eds));
    },
    [],
  );

  const pendingConnectionRef = useRef<{ sourceNodeId: string; sourceHandle: string; kind: 'image' | 'video' | 'audio' | 'text' } | null>(null);

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    if (params.handleType !== 'source' || !params.nodeId || !params.handleId) {
      pendingConnectionRef.current = null;
      return;
    }
    const kind = params.handleId.endsWith('-source') ? params.handleId.slice(0, -7) : '';
    pendingConnectionRef.current = ['image', 'video', 'audio', 'text'].includes(kind)
      ? { sourceNodeId: params.nodeId, sourceHandle: params.handleId, kind: kind as 'image' | 'video' | 'audio' | 'text' }
      : null;
  }, []);

  /** 输出端点拖到画布空白处：打开只包含兼容输入工作流的创建菜单。 */
  const onConnectEnd: OnConnectEnd = useCallback((event, connectionState) => {
    const pending = pendingConnectionRef.current;
    pendingConnectionRef.current = null;
    if (connectionState.isValid || !pending) return;
    const point = 'changedTouches' in event && event.changedTouches.length
      ? event.changedTouches[0]
      : event as MouseEvent;
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
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
  }, []);

  /** 删除节点 + 其相连边（自定义节点经 Context 调用，二次确认在节点内） */
  const handleDeleteNode = useCallback(async (nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (node?.type === NODE_TYPE_TXT2IMG && id) {
      try {
        await request('/api/assets/generated/by-node', {
          method: 'DELETE',
          params: { canvasId: id, nodeId },
        });
      } catch (error: any) {
        message.error(error?.response?.data?.message || '生成资产清理失败，节点未删除');
        throw error;
      }
    }
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setNodeRuns((runs) => {
      if (!(nodeId in runs)) return runs;
      const next = { ...runs };
      delete next[nodeId];
      return next;
    });
  }, [id]);

  const ensureResultNode = useCallback((sourceNodeId: string, kind: 'image' | 'video' = 'image') => {
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
  }, []);

  const setNodeRunState = useCallback((nodeId: string, run: RunStateData | null) => {
    setNodeRuns((prev) => ({ ...prev, [nodeId]: run }));
  }, []);

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

  const handleMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
    setViewport(nextViewport);
  }, []);

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
            targetHandle: `input:${input.nodeId}:${input.param}`,
          };
          setEdges((eds) => [...eds, edge]);
        }
      }
      setMenu(null);
    },
    [menu, screenToFlowPosition],
  );

  const nodeCount = nodes.length;
  const saveTag = useMemo(() => {
    switch (saveStatus) {
      case 'dirty': return { color: 'default', text: '待保存' };
      case 'saving': return { color: 'processing', text: '保存中' };
      case 'saved': return { color: 'success', text: '已保存' };
      case 'error': return { color: 'error', text: '保存失败' };
      default: return null;
    }
  }, [saveStatus]);

  // 窄屏：根容器测出自身顶部偏移后，改用 fixed 铺满 header 下方到屏幕底（bottom:0），
  // 不再依赖高度计算，避免 iOS visualViewport 误差导致画布铺不到底/留白。
  const narrowFixed = isNarrow && rootTop != null;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
        ...(narrowFixed
          ? {
              position: 'fixed',
              top: rootTop as number,
              left: 0,
              right: 0,
              bottom: 0,
              padding: '0 6px 6px',
              background: '#fff',
              zIndex: 1,
            }
          : {
              height: rootHeight != null ? rootHeight : 'calc(100dvh - 56px)',
              padding: '0 24px 24px',
            }),
      }}
    >
      {/* 顶栏：窄屏隐藏次要信息（更新时间 / 操作提示），避免被挤成竖排逐字换行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'nowrap',
          padding: isNarrow ? '8px 0' : '12px 0',
          minWidth: 0,
        }}
      >
        <Link to="/canvas" style={{ flexShrink: 0 }}>
          <Button icon={<ArrowLeftOutlined />} size={isNarrow ? 'small' : 'middle'}>
            {isNarrow ? '' : '返回列表'}
          </Button>
        </Link>
        {doc ? (
          <>
            <Title
              level={isNarrow ? 5 : 4}
              style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {doc.name}
            </Title>
            <Tag color="blue" style={{ flexShrink: 0, marginInlineEnd: 0 }}>{nodeCount} 节点</Tag>
            {saveTag ? <Tag color={saveTag.color} style={{ flexShrink: 0, marginInlineEnd: 0 }}>{saveTag.text}</Tag> : null}
            {!isNarrow ? (
              <Text type="secondary" style={{ flexShrink: 0 }}>更新于 {formatTime(savedAt || doc.updatedAt)}</Text>
            ) : null}
          </>
        ) : null}
        {!isNarrow ? (
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0, marginLeft: 'auto' }}>
            在画布空白处右键添加节点
          </Text>
        ) : null}
      </div>

      {/* 画布主体 */}
      <div
        ref={containerRef}
        onContextMenu={onPaneContextMenu}
        onClickCapture={onContainerClickCapture}
        style={{
          flex: 1,
          position: 'relative',
          border: '1px solid rgba(5,5,5,0.06)',
          borderRadius: 8,
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
            updateNodeData: handleUpdateNodeData,
            deleteNode: handleDeleteNode,
            ensureResultNode,
            setNodeRunState,
            getResultState,
            getUpstreamAsset,
          }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={canvasNodeTypes}
              defaultViewport={doc.graph?.viewport ?? undefined}
              fitView={!doc.graph?.viewport}
              onMoveEnd={handleMoveEnd}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>

            <CanvasContextMenu state={menu} onClose={() => setMenu(null)} onPick={handlePickWorkflow} />

            {/* 空白画布提示 */}
            {nodeCount === 0 ? (
              <div
                style={{
                  position: 'absolute',
                  top: 16,
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
                    ? '空白画布 · 长按选择「文生图 → 工作流」添加节点'
                    : '空白画布 · 右键选择「文生图 → 工作流」添加节点'}
                </Text>
              </div>
            ) : null}
          </CanvasNodeDataContext.Provider>
        ) : null}
      </div>
    </div>
  );
}
