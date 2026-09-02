import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Space, Spin, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Link, useParams, request } from 'umi';

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

/** ISO 时间 → YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CanvasEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
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

  const nodes: Node[] = doc?.graph?.nodes ?? [];
  const edges: Edge[] = doc?.graph?.edges ?? [];
  const viewport: Viewport | undefined = doc?.graph?.viewport ?? undefined;
  const nodeCount = nodes.length;

  const onConnect = useCallback(() => {
    // C3 为编辑器外壳：节点/连线编辑与自动保存由后续迭代（C5/C7）落地
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 56px)',
        padding: '0 24px 24px',
      }}
    >
      {/* 顶栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 0',
        }}
      >
        <Space>
          <Link to="/canvas">
            <Button icon={<ArrowLeftOutlined />}>返回列表</Button>
          </Link>
          {doc ? (
            <>
              <Title level={4} style={{ margin: 0 }}>
                {doc.name}
              </Title>
              <Tag color="blue">{nodeCount} 个节点</Tag>
              <Text type="secondary">更新于 {formatTime(doc.updatedAt)}</Text>
            </>
          ) : null}
        </Space>
      </div>

      {/* 画布主体 */}
      <div style={{ flex: 1, position: 'relative', border: '1px solid rgba(5,5,5,0.06)', borderRadius: 8, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Spin size="large" tip="加载画布中…" />
          </div>
        ) : loadError ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text type="danger">{loadError}</Text>
          </div>
        ) : doc ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onConnect={onConnect}
            defaultViewport={viewport}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <MiniMap />
            <Controls />
          </ReactFlow>
        ) : null}

        {/* 空白画布提示（节点工具栏在后续迭代提供） */}
        {!loading && !loadError && doc && nodeCount === 0 ? (
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
            <Text type="secondary">空白画布 · 暂未添加节点</Text>
          </div>
        ) : null}
      </div>
    </div>
  );
}
