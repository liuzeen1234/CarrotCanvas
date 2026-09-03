/** C6 文生图节点：schema 表单、提交校验、运行/中断与平台资产回写。 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Popconfirm, Progress, Spin, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { ComfyUIAPI, RunStateData, SchemaField, applyFormValues, fileKey, splitByExposure } from '@/components/comfyui/types';
import { ComfySchemaForm } from '@/components/comfyui/ComfySchemaForm';
import { useComfyRun } from '@/components/comfyui/useComfyRun';
import { CanvasNodeDataContext } from '../context';
import { Txt2ImgNodeData, resultSourceHandle, workflowInputHandle, workflowOutputKind } from './types';

const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

export default function Txt2ImgNode(props: NodeProps) {
  const data = props.data as Txt2ImgNodeData;
  const { canvasId, updateNodeData, deleteNode, ensureResultNode, setNodeRunState, getUpstreamAsset } = useContext(CanvasNodeDataContext);
  const [workflow, setWorkflow] = useState<ComfyUIAPI | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missingKeys, setMissingKeys] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const nodeId = props.id;

  const onRunStarted = useCallback((state: RunStateData) => setNodeRunState(nodeId, state), [nodeId, setNodeRunState]);
  const onRunFinished = useCallback((state: RunStateData) => {
    setNodeRunState(nodeId, state);
    if (state.status !== 'success') return;
    const assets = state.outputs.filter((o) => o.assetId && o.assetUrl).map((o) => ({ assetId: o.assetId!, url: o.assetUrl!, kind: o.kind, filename: o.filename }));
    if (assets.length) updateNodeData(nodeId, { lastAssets: assets });
  }, [nodeId, setNodeRunState, updateNodeData]);

  const run = useComfyRun({ workflow, canvas: { canvasId, nodeId }, onRunStarted, onRunFinished });

  useEffect(() => {
    if (!data.workflowId) return;
    let alive = true;
    initializedRef.current = false;
    setWorkflowLoading(true);
    setLoadError(null);
    request<ComfyUIAPI>(`/api/workflows/${data.workflowId}`)
      .then((loaded) => {
        if (!alive) return;
        setWorkflow(loaded);
        return run.init(loaded, data.formValues ?? {}).then(() => { initializedRef.current = true; });
      })
      .catch((error: any) => {
        if (!alive) return;
        setWorkflow(null);
        setLoadError(error?.response?.data?.message || '绑定的工作流已不存在');
      })
      .finally(() => { if (alive) setWorkflowLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.workflowId]);

  useEffect(() => {
    if (!initializedRef.current) return;
    const timer = setTimeout(() => updateNodeData(nodeId, { formValues: run.formValues }), 300);
    return () => clearTimeout(timer);
  }, [nodeId, run.formValues, updateNodeData]);

  useEffect(() => setNodeRunState(nodeId, run.runState), [nodeId, run.runState, setNodeRunState]);

  const exposedKeys = useMemo(() => {
    if (!run.schema || !workflow) return new Set<string>();
    const { primary } = splitByExposure(run.schema, workflow.exposureConfig);
    return new Set(primary.flatMap((group) => group.fields.map(fileKey)));
  }, [run.schema, workflow]);

  const inputKinds = useMemo(() => new Map(
    (workflow?.inputConfig?.fields ?? []).map((f) => [`${f.nodeId}::${f.param}`, f.kind]),
  ), [workflow]);

  const upstreamFor = useCallback((field: { nodeId: string; param: string }) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    return kind ? getUpstreamAsset(nodeId, workflowInputHandle(field.nodeId, field.param), kind) : null;
  }, [getUpstreamAsset, inputKinds, nodeId]);

  const handleRun = async () => {
    if (!run.schema || !workflow) return;
    const missing = new Set<string>();
    for (const group of run.schema.groups) for (const field of group.fields) {
      const key = fileKey(field);
      if (!exposedKeys.has(key) || field.control === 'hidden') continue;
      if ((field.required || field.control === 'upload') && isEmpty(run.formValues[key]) && !upstreamFor(field)) missing.add(key);
    }
    setMissingKeys(missing);
    if (missing.size) { message.warning(`请先填写 ${missing.size} 个必填参数`); return; }
    ensureResultNode(nodeId, workflowOutputKind(workflow.category));
    try {
      const resolvedValues = { ...run.formValues };
      for (const input of workflow.inputConfig?.fields ?? []) {
        const asset = upstreamFor(input);
        if (!asset) continue;
        if (input.kind !== 'image') throw new Error(`暂不支持 ${input.kind} 输入回灌`);
        const uploaded = await request<{ file: { name: string } }>('/api/comfyui/upload/asset', {
          method: 'POST', data: { canvasId, assetId: asset.assetId },
        });
        resolvedValues[`${input.nodeId}::${input.param}`] = uploaded.file.name;
      }
      await run.submit(applyFormValues(workflow.apiJson, resolvedValues));
    }
    catch (error: any) { message.error(error?.response?.data?.message || '提交运行失败'); }
  };

  const renderInputConnector = useCallback((field: SchemaField) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    if (!kind) return null;
    const connected = !!upstreamFor(field);
    return <Handle type="target" position={Position.Left} id={workflowInputHandle(field.nodeId, field.param)}
      className={`canvas-handle--${kind}`} style={{ left: -15, top: 18, background: connected ? '#52c41a' : undefined }}
      title={`${field.label} · ${kind} 输入${connected ? '（已连接）' : ''}`} />;
  }, [inputKinds, upstreamFor]);

  const getConnectedImage = useCallback((field: SchemaField) => {
    const asset = upstreamFor(field);
    if (!asset || asset.kind !== 'image') return null;
    return { url: asset.url, label: asset.filename || '上游生成图片' };
  }, [upstreamFor]);

  const progress = run.runState?.progress;
  const percent = progress?.max ? Math.round((progress.value / progress.max) * 100) : undefined;
  const statusLabel: Record<string, string> = { pending: '排队中', running: run.runState?.currentNodeTitle || '生成中', success: '生成完成', error: '运行失败', interrupted: '已中断', unknown: '状态未知' };

  return <div className={`canvas-node canvas-node--txt2img${props.selected ? ' selected' : ''}`}>
    <div className="canvas-node__header">
      <span className="canvas-node__type" style={{ background: workflow?.category === 'img2img' ? '#52c41a' : '#1677ff' }}>{workflow?.categoryLabel || '工作流'}</span>
      <span className="canvas-node__bind" title={data.workflowName}>{data.workflowName || '未绑定工作流'}</span>
      {run.running
        ? <Tooltip title="中断运行"><Button size="small" type="text" danger icon={<PauseCircleOutlined />} className="nodrag" onClick={() => void run.interrupt()} /></Tooltip>
        : <Tooltip title={loadError || '运行'}><Button size="small" type="text" icon={<PlayCircleOutlined />} className="nodrag" disabled={!workflow || !!loadError || workflowLoading} loading={run.submitting} onClick={() => void handleRun()} /></Tooltip>}
      <Popconfirm title="删除该节点？" description="将同时移除连线及该节点生成的资产，不可撤销。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => deleteNode(nodeId)}>
        <Tooltip title="删除节点"><Button size="small" type="text" danger icon={<DeleteOutlined />} className="nodrag" /></Tooltip>
      </Popconfirm>
    </div>
    <div className="canvas-node__body canvas-node__form-body nodrag">
      {!data.workflowId ? <Alert type="warning" showIcon message="未绑定工作流" />
        : workflowLoading || run.schemaLoading ? <div style={{ textAlign: 'center', padding: '16px 0' }}><Spin size="small" /><div style={{ color: '#999', marginTop: 6 }}>加载入参表单…</div></div>
        : loadError || run.schemaError ? <Alert type="warning" showIcon message={loadError || run.schemaError} description={data.lastAssets?.length ? '历史结果仍可在结果节点查看。' : undefined} />
        : <ComfySchemaForm schema={run.schema} values={run.formValues} onChange={(key, value) => { run.handleFormChange(key, value); setMissingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; }); }} disabled={run.running} exposure={workflow?.exposureConfig ?? null} onUploadImage={run.uploadImage} uploading={run.uploading} scroll={false} singleColumn invalidKeys={missingKeys} renderInputConnector={renderInputConnector} getConnectedImage={getConnectedImage} />}
      {missingKeys.size > 0 && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`还有 ${missingKeys.size} 个必填参数未填写`} />}
      {run.runState && <div style={{ marginTop: 8 }}>
        {run.running ? <Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /> : null}
        <Tag color={run.runState.status === 'success' ? 'success' : run.runState.status === 'error' ? 'error' : run.runState.status === 'interrupted' ? 'warning' : 'processing'}>{statusLabel[run.runState.status] || run.runState.status}</Tag>
        {run.runState.error ? <div style={{ color: '#ff4d4f', marginTop: 4, wordBreak: 'break-word' }}>{run.runState.error}</div> : null}
      </div>}
    </div>
    <Handle type="source" position={Position.Right} id={resultSourceHandle(workflowOutputKind(workflow?.category))} className={`canvas-handle--${workflowOutputKind(workflow?.category)}`} title={`${workflowOutputKind(workflow?.category) === 'video' ? '视频' : '图片'}输出`} />
  </div>;
}
