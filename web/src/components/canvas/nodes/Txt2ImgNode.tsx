/**
 * CarrotCanvas 文生图生成节点（C5，新交互）。
 * 创建时即绑定工作流（右键分级菜单落点写入 workflowId/workflowName，§4.2.1），
 * 节点内嵌「自动生成的暴露字段表单」（复用共享件 ComfySchemaForm，与设置页运行面板同一套），
 * 提示词并入表单里的多行字段——不再有节点内工作流选择器、也没有独立提示词节点。
 * 输出句柄：image（生成结果，下传结果节点）。
 * 运行 / 参数校验 / 自动连出结果节点 / 提交轮询由 C6 接入（此处运行按钮占位）。
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Popconfirm, Spin, Tag, Tooltip } from 'antd';
import { DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { ComfyUIAPI, SchemaAnalysis, fileKey } from '@/components/comfyui/types';
import { ComfySchemaForm } from '@/components/comfyui/ComfySchemaForm';
import { CanvasNodeDataContext } from '../context';
import { HANDLE_IMAGE_SOURCE, Txt2ImgNodeData } from './types';

export default function Txt2ImgNode(props: NodeProps) {
  const data = props.data as Txt2ImgNodeData;
  const { updateNodeData, deleteNode } = useContext(CanvasNodeDataContext);

  const [workflow, setWorkflow] = useState<ComfyUIAPI | null>(null);
  const [schema, setSchema] = useState<SchemaAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(data.formValues ?? {});

  const nodeId = props.id;
  const workflowId = data.workflowId;

  // 加载绑定工作流 + schema，并用 schema 默认值 / 持久化 formValues 初始化表单
  useEffect(() => {
    if (!workflowId) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      request<ComfyUIAPI>(`/api/workflows/${workflowId}`),
      request<{ schema: SchemaAnalysis }>(`/api/comfyui/workflows/${workflowId}/schema`),
    ])
      .then(([wf, schemaRes]) => {
        if (!alive) return;
        setWorkflow(wf);
        setSchema(schemaRes.schema);
        // 初值：schema 默认值 ← 持久化 formValues 覆盖
        const initVals: Record<string, unknown> = {};
        for (const g of schemaRes.schema.groups) {
          for (const f of g.fields) {
            if (f.control === 'hidden') continue;
            initVals[fileKey(f)] = f.current;
          }
        }
        setValues((prev) => ({ ...initVals, ...(data.formValues ?? {}), ...prev }));
      })
      .catch((e: any) => {
        if (!alive) return;
        setLoadError(e?.response?.data?.message || '工作流 / 表单加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // 仅在绑定的 workflowId 变化时重载（formValues 初值只在此时取一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  // 表单值变更去抖回写节点 data（graph 持久化）
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => updateNodeData(nodeId, { formValues: next }), 300);
      return next;
    });
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const exposure = useMemo(() => workflow?.exposureConfig ?? null, [workflow]);

  return (
    <div className={`canvas-node canvas-node--txt2img${props.selected ? ' selected' : ''}`}>
      <div className="canvas-node__header">
        <span className="canvas-node__type" style={{ background: '#1677ff' }}>
          文生图
        </span>
        <span className="canvas-node__bind" title={data.workflowName}>
          {data.workflowName || '未绑定工作流'}
        </span>
        <Tooltip title="运行（C6 开放）">
          <Button size="small" type="text" icon={<PlayCircleOutlined />} disabled />
        </Tooltip>
        <Popconfirm
          title="删除该节点？"
          description="将同时移除与它相连的连线，不可撤销。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() => deleteNode(props.id)}
        >
          <Tooltip title="删除节点">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} className="nodrag" />
          </Tooltip>
        </Popconfirm>
      </div>

      <div className="canvas-node__body canvas-node__form-body nodrag">
        {!workflowId ? (
          <Alert type="warning" showIcon message="未绑定工作流" />
        ) : loading ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Spin size="small" />
            <div style={{ color: '#999', marginTop: 6 }}>加载入参表单…</div>
          </div>
        ) : loadError ? (
          <Alert type="warning" showIcon message={loadError} />
        ) : (
          <ComfySchemaForm
            schema={schema}
            values={values}
            onChange={handleChange}
            exposure={exposure}
            scroll={false}
            singleColumn
          />
        )}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, color: '#888' }}>
          <Tag color="blue">txt2img</Tag>
          <span style={{ fontSize: 12 }}>运行与结果在 C6 开放</span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id={HANDLE_IMAGE_SOURCE}
        className="canvas-handle--image"
        title="生成结果输出"
      />
    </div>
  );
}
