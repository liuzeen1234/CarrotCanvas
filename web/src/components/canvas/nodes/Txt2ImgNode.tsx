/** C6 文生图节点：schema 表单、提交校验、运行/中断与平台资产回写。 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Popconfirm, Progress, Space, Spin, Tag, Upload, message } from 'antd';
import { CloseCircleFilled, DeleteOutlined, DownloadOutlined, PauseCircleOutlined, PlayCircleFilled, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { ComfyUIAPI, RunStateData, SchemaField, applyFormValues, fileKey, splitByExposure } from '@/components/comfyui/types';
import { ComfySchemaForm } from '@/components/comfyui/ComfySchemaForm';
import { useComfyRun } from '@/components/comfyui/useComfyRun';
import { CanvasNodeDataContext } from '../context';
import { Txt2ImgNodeData, resultSourceHandle, workflowInputHandle, workflowOutputKind, workflowReferenceImagesHandle } from './types';
import NodeOutputHistory from '../NodeOutputHistory';
import { RunElapsed } from '../RunTiming';
import CanvasMediaPreview, { type CanvasMediaItem } from '../CanvasMediaPreview';
import { AssetIdLabel, NodeCardFields } from './NodeCardFields';
import { ImeSafeMentions } from '../ImeSafeInput';

const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function referenceConfig(workflow: ComfyUIAPI | null) {
  if (!workflow) return null;
  const api = workflow.apiJson as Record<string, any>;
  const h3 = Object.entries(api).find(([, node]) => node?.class_type === 'MiniMaxH3ReferenceToVideo');
  if (h3) {
    const [nodeId, node] = h3;
    const slots = Array.from({ length: 9 }, (_, index) => {
      const param = `ref_images.ref_image_${index}`;
      const value = node.inputs?.[param];
      if (Array.isArray(value)) return workflow.inputConfig?.fields.find((field) => field.kind === 'image' && field.nodeId === String(value[0])) || null;
      return workflow.inputConfig?.fields.find((field) => field.kind === 'image' && field.nodeId === nodeId && field.param === param) || null;
    }).filter(Boolean) as Array<{ nodeId: string; param: string; kind: 'image' }>;
    const promptLink = node.inputs?.prompt;
    const promptField = Array.isArray(promptLink) ? workflow.inputConfig?.fields.find((field) => field.kind === 'text' && field.nodeId === String(promptLink[0])) : null;
    return { max: 9, slots, promptKey: promptField ? `${promptField.nodeId}::${promptField.param}` : null, tag: 'Picture' };
  }
  if (workflow.category === 'img2img' && /z[- ]?image/i.test(workflow.name)) {
    const slot = workflow.inputConfig?.fields.find((field) => field.kind === 'image');
    return slot ? { max: 1, slots: [slot], promptKey: null, tag: null } : null;
  }
  return null;
}

export default function Txt2ImgNode(props: NodeProps) {
  const data = props.data as Txt2ImgNodeData;
  const { canvasId, control, readOnly, updateNodeData, observeNodeData, deleteNode, setNodeRunState, getNodeRunState, getUpstreamAsset, getUpstreamAssets, disconnectEdge, getUpstreamText, generationHistoryVersion } = useContext(CanvasNodeDataContext);
  const [workflow, setWorkflow] = useState<ComfyUIAPI | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [referencePreviewIndex, setReferencePreviewIndex] = useState<number | null>(null);
  const [missingKeys, setMissingKeys] = useState<Set<string>>(new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const initializedRef = useRef(false);
  const nodeId = props.id;

  const onRunStarted = useCallback((state: RunStateData) => setNodeRunState(nodeId, state), [nodeId, setNodeRunState]);
  const onRunFinished = useCallback((state: RunStateData) => {
    setNodeRunState(nodeId, state);
    if (state.status !== 'success') return;
    const assets = state.outputs.filter((o) => o.assetId && o.assetUrl).map((o) => ({ assetId: o.assetId!, url: o.assetUrl!, kind: o.kind, filename: o.filename }));
    if (assets.length) updateNodeData(nodeId, { lastAssets: assets });
    setHistoryVersion((value) => value + 1);
  }, [nodeId, setNodeRunState, updateNodeData]);

  const run = useComfyRun({ workflow, canvas: { canvasId, nodeId, ...control }, onRunStarted, onRunFinished });

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
        return run.init(loaded, data.formValues ?? {}, data.autoRandomSeedKeys ?? []).then(() => { initializedRef.current = true; });
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

  useEffect(() => {
    if (!initializedRef.current) return;
    const timer = setTimeout(() => updateNodeData(nodeId, { autoRandomSeedKeys: [...run.autoRandomSeedKeys] }), 300);
    return () => clearTimeout(timer);
  }, [nodeId, run.autoRandomSeedKeys, updateNodeData]);

  useEffect(() => setNodeRunState(nodeId, run.runState), [nodeId, run.runState, setNodeRunState]);

  const exposedKeys = useMemo(() => {
    if (!run.schema || !workflow) return new Set<string>();
    const { primary } = splitByExposure(run.schema, workflow.exposureConfig);
    return new Set(primary.flatMap((group) => group.fields.map(fileKey)));
  }, [run.schema, workflow]);

  const inputKinds = useMemo(() => new Map(
    (workflow?.inputConfig?.fields ?? []).map((f) => [`${f.nodeId}::${f.param}`, f.kind]),
  ), [workflow]);

  const refConfig = useMemo(() => referenceConfig(workflow), [workflow]);
  const legacyConnectedReferences = refConfig ? refConfig.slots.flatMap((field) => getUpstreamAssets(nodeId, workflowInputHandle(field.nodeId, field.param, 'image'), 'image')) : [];
  const connectedReferences = refConfig ? [...legacyConnectedReferences, ...getUpstreamAssets(nodeId, workflowReferenceImagesHandle(), 'image')] : [];
  const embeddedReferences = refConfig ? refConfig.slots.flatMap((field, index) => {
    if (getUpstreamAssets(nodeId, workflowInputHandle(field.nodeId, field.param, 'image'), 'image').length) return [];
    const key = `${field.nodeId}::${field.param}`;
    const filename = String(run.formValues[key] ?? data.formValues?.[key] ?? '').trim();
    if (!filename) return [];
    const normalized = filename.replace(/\\/g, '/'); const slash = normalized.lastIndexOf('/');
    const query = new URLSearchParams({ filename: slash >= 0 ? normalized.slice(slash + 1) : normalized, type: 'input' });
    if (slash >= 0) query.set('subfolder', normalized.slice(0, slash));
    return [{ referenceId: `field:${key}`, edgeId: '', sourceNodeId: '', displayName: normalized.split('/').at(-1) || `参考图 ${index + 1}`, assetId: '', url: `/api/comfyui/view?${query.toString()}`, kind: 'image', filename }];
  }) : [];
  const uploadedReferences = data.referenceImages || [];
  const referenceOrder = data.referenceImageOrder || [];
  const references = useMemo(() => [...connectedReferences, ...embeddedReferences, ...uploadedReferences].sort((a, b) => {
    const ai = referenceOrder.indexOf(a.referenceId), bi = referenceOrder.indexOf(b.referenceId);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  }), [connectedReferences, embeddedReferences, uploadedReferences, referenceOrder]);
  const referencePrompt = refConfig?.promptKey ? String(run.formValues[refConfig.promptKey] ?? data.formValues?.[refConfig.promptKey] ?? '') : '';
  const activeBindings = (data.promptImageReferences || []).filter((binding) => referencePrompt.includes(binding.token));
  const missingBindings = activeBindings.filter((binding) => !references.some((item) => item.referenceId === binding.referenceId));
  const hiddenReferenceKeys = useMemo(() => new Set([
    ...(refConfig?.slots || []).map((field) => `${field.nodeId}::${field.param}`),
    ...(refConfig?.promptKey ? [refConfig.promptKey] : []),
  ]), [refConfig]);

  const updateReferencePrompt = (prompt: string) => {
    if (!refConfig?.promptKey) return;
    run.handleFormChange(refConfig.promptKey, prompt);
    updateNodeData(nodeId, { promptImageReferences: (data.promptImageReferences || []).filter((binding) => prompt.includes(binding.token)) });
  };
  const removeReference = (referenceId: string) => {
    const binding = activeBindings.find((item) => item.referenceId === referenceId);
    if (binding) { message.error(`“${binding.displayName}”仍被提示词引用，请先删除 ${binding.token}`); return; }
    const connected = connectedReferences.find((item) => item.referenceId === referenceId);
    if (connected) disconnectEdge(connected.edgeId);
    else if (referenceId.startsWith('field:')) run.handleFormChange(referenceId.slice('field:'.length), '');
    else updateNodeData(nodeId, { referenceImages: uploadedReferences.filter((item) => item.referenceId !== referenceId) });
    updateNodeData(nodeId, { referenceImageOrder: referenceOrder.filter((id) => id !== referenceId) });
  };
  const moveReference = (fromId: string, toId: string) => {
    const order = references.map((item) => item.referenceId); const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = order.splice(from, 1); order.splice(to, 0, moved); updateNodeData(nodeId, { referenceImageOrder: order });
  };
  const uploadReference = async (file: File) => {
    if (!canvasId || !control || !refConfig) { message.error('当前画布不可写'); return false; }
    if (references.length >= refConfig.max) { message.error(`参考图片最多 ${refConfig.max} 张`); return false; }
    const form = new FormData(); form.append('file', file); form.append('kind', 'image'); form.append('canvasId', canvasId); form.append('nodeId', nodeId);
    form.append('leaseToken', control.leaseToken); form.append('leaseEpoch', String(control.leaseEpoch)); form.append('expectedRevision', String(control.expectedRevision));
    try {
      const response = await fetch('/api/comfyui/upload/media', { method: 'POST', body: form });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || '上传失败');
      const { asset } = await response.json(); const referenceId = `asset:${asset.assetId}`;
      updateNodeData(nodeId, { referenceImages: [...uploadedReferences, { referenceId, ...asset, displayName: asset.filename || file.name }], referenceImageOrder: [...referenceOrder.filter((id) => references.some((item) => item.referenceId === id)), referenceId] });
    } catch (error: any) { message.error(error?.message || '上传失败'); }
    return false;
  };

  const upstreamAssetFor = useCallback((field: { nodeId: string; param: string }) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    return kind && kind !== 'text' ? getUpstreamAsset(nodeId, workflowInputHandle(field.nodeId, field.param, kind), kind) : null;
  }, [getUpstreamAsset, inputKinds, nodeId]);

  const upstreamTextFor = useCallback((field: { nodeId: string; param: string }) => {
    const key = `${field.nodeId}::${field.param}`;
    if (inputKinds.get(key) !== 'text') return { connected: false, text: '' };
    return getUpstreamText(nodeId, workflowInputHandle(field.nodeId, field.param, 'text'));
  }, [getUpstreamText, inputKinds, nodeId]);

  const handleRun = async () => {
    if (readOnly) { message.warning('当前为只读，需取得画布控制权后才能运行'); return; }
    if (!run.schema || !workflow) return;
    const missing = new Set<string>();
    for (const group of run.schema.groups) for (const field of group.fields) {
      const key = fileKey(field);
      if (!exposedKeys.has(key) || field.control === 'hidden' || hiddenReferenceKeys.has(key)) continue;
      const upstreamText = upstreamTextFor(field);
      const effectiveValue = upstreamText.connected ? upstreamText.text : run.formValues[key];
      if (field.required && isEmpty(effectiveValue) && !upstreamAssetFor(field)) missing.add(key);
    }
    setMissingKeys(missing);
    if (missing.size) { message.warning(`请先填写 ${missing.size} 个必填参数`); return; }
    if (refConfig && references.length === 0) { message.warning('请先添加至少一张参考图片'); return; }
    if (missingBindings.length) { message.error('提示词中存在已缺失的图片引用，请先解除或重新连接'); return; }
    try {
      const resolvedValues = { ...run.formValues };
      const inputAssetIds = new Set<string>();
      if (refConfig) {
        for (const slot of refConfig.slots) resolvedValues[`${slot.nodeId}::${slot.param}`] = '';
        for (const [index, reference] of references.entries()) {
          const slot = refConfig.slots[index];
          if (!slot) throw new Error(`参考图片超过工作流上限 ${refConfig.max} 张`);
          if (reference.assetId) {
            const uploaded = await request<{ file: { name: string } }>('/api/comfyui/upload/asset', { method: 'POST', data: { canvasId, assetId: reference.assetId } });
            resolvedValues[`${slot.nodeId}::${slot.param}`] = uploaded.file.name;
            inputAssetIds.add(reference.assetId);
          } else resolvedValues[`${slot.nodeId}::${slot.param}`] = reference.filename || '';
        }
        if (refConfig.promptKey) {
          let compiled = referencePrompt;
          for (const binding of activeBindings) {
            const index = references.findIndex((item) => item.referenceId === binding.referenceId);
            if (index >= 0) compiled = compiled.split(binding.token).join(`<${refConfig.tag} ${index + 1}>`);
          }
          resolvedValues[refConfig.promptKey] = compiled;
        }
      }
      for (const input of workflow.inputConfig?.fields ?? []) {
        if (hiddenReferenceKeys.has(`${input.nodeId}::${input.param}`)) continue;
        if (input.kind === 'text') {
          const upstreamText = upstreamTextFor(input);
          if (upstreamText.connected) {
            if (isEmpty(upstreamText.text)) throw new Error('上游文本节点尚未输出内容');
            resolvedValues[`${input.nodeId}::${input.param}`] = upstreamText.text;
          }
          continue;
        }
        const asset = upstreamAssetFor(input);
        if (!asset) {
          if (getUpstreamText(nodeId, workflowInputHandle(input.nodeId, input.param, input.kind)).connected) throw new Error('上游媒体节点尚未上传或生成内容');
          continue;
        }
        inputAssetIds.add(asset.assetId);
        const uploaded = await request<{ file: { name: string } }>('/api/comfyui/upload/asset', {
          method: 'POST', data: { canvasId, assetId: asset.assetId },
        });
        resolvedValues[`${input.nodeId}::${input.param}`] = uploaded.file.name;
      }
      await run.submit(applyFormValues(workflow.apiJson, resolvedValues), new Set((workflow.inputConfig?.fields ?? []).filter(f => f.kind === 'text' && upstreamTextFor(f).connected).map(fileKey)), [...inputAssetIds], refConfig ? {
        originalPrompt: referencePrompt,
        imageReferenceMap: references.map((item, index) => ({ referenceId: item.referenceId, assetId: item.assetId || null, position: index + 1, displayName: item.displayName, token: activeBindings.find((binding) => binding.referenceId === item.referenceId)?.token || null })),
      } : undefined);
    }
    catch (error: any) { message.error(error?.response?.data?.message || error?.message || '提交运行失败'); }
  };

  const renderInputConnector = useCallback((field: SchemaField) => {
    const key = `${field.nodeId}::${field.param}`;
    const kind = inputKinds.get(key);
    if (!kind) return null;
    const connected = kind === 'text' ? upstreamTextFor(field).connected : !!upstreamAssetFor(field);
    return <Handle type="target" position={Position.Left} id={workflowInputHandle(field.nodeId, field.param, kind)}
      className={`canvas-handle--${kind}`} style={{ left: -15, top: 18, background: connected ? '#52c41a' : undefined }}
      title={`${field.label} · ${kind} 输入${connected ? '（已连接）' : ''}`} />;
  }, [inputKinds, upstreamAssetFor, upstreamTextFor]);

  const getConnectedImage = useCallback((field: SchemaField) => {
    const asset = upstreamAssetFor(field);
    if (!asset) return null;
    return { url: asset.url, label: asset.filename || '上游媒体' };
  }, [upstreamAssetFor]);

  const getConnectedText = useCallback((field: SchemaField) => {
    const upstream = upstreamTextFor(field);
    return upstream.connected ? { text: upstream.text } : null;
  }, [upstreamTextFor]);

  const visibleRunState = run.runState ?? getNodeRunState(nodeId);
  const outputKind = workflowOutputKind(workflow?.category);
  const visibleRunning = visibleRunState?.status === 'pending' || visibleRunState?.status === 'running';
  const progress = visibleRunState?.progress;
  const percent = progress?.max ? Math.round((progress.value / progress.max) * 100) : undefined;
  const statusLabel: Record<string, string> = { pending: '排队中', running: visibleRunState?.currentNodeTitle || '生成中', success: '生成完成', error: '运行失败', interrupted: '已中断', unknown: '状态未知' };

  return <div className={`canvas-node canvas-node--txt2img${props.selected ? ' selected' : ''}${missingBindings.length ? ' canvas-node--reference-error' : ''}`}>
    <div className="canvas-node__header">
      <span className="canvas-node__type" style={{ background: workflow?.category === 'img2img' ? '#52c41a' : '#1677ff' }}>{workflow?.categoryLabel || '工作流'}</span>
      <span className="canvas-node__bind" title={data.cardName || data.workflowName}>{data.cardName || data.workflowName || '未绑定工作流'}</span>
      <RunElapsed status={visibleRunState?.status} queuedAt={visibleRunState?.queuedAt} startedAt={visibleRunState?.startedAt} />
      {run.running
        ? <Button size="small" type="text" danger disabled={readOnly} icon={<PauseCircleOutlined />} className="nodrag canvas-node__run-action" aria-label="中断运行" onClick={() => void run.interrupt()} />
        : <Popconfirm title="确认运行该节点？" description="运行可能消耗 API 额度并需要一定时间。" okText="确认运行" cancelText="取消" onConfirm={() => void handleRun()}>
            <Button size="small" type="text" icon={<PlayCircleOutlined />} className="nodrag canvas-node__run-action" aria-label="运行节点" disabled={readOnly || !workflow || !!loadError || workflowLoading} loading={run.submitting} />
          </Popconfirm>}
      <Popconfirm title="删除该节点？" description="将同时移除连线及该节点生成的资产，不可撤销。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => deleteNode(nodeId)}>
        <Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" aria-label="删除节点" />
      </Popconfirm>
    </div>
    <div className="canvas-node__body canvas-node__form-body nodrag">
      <NodeCardFields name={data.cardName} note={data.note} readOnly={readOnly} onChange={(patch) => updateNodeData(nodeId, patch)} />
      {refConfig ? <>
        <div className="canvas-reference-summary" style={{ position: 'relative' }}>
          <Handle type="target" position={Position.Left} id={workflowReferenceImagesHandle()} className="canvas-handle--image" style={{ left: -15 }} title={`参考图片输入（最多 ${refConfig.max} 张）`} />
          <strong>参考图 {references.length} / {refConfig.max}</strong>
          <Upload disabled={readOnly || references.length >= refConfig.max} accept="image/*" multiple showUploadList={false} beforeUpload={uploadReference}><Button size="small" disabled={readOnly || references.length >= refConfig.max} icon={<UploadOutlined />}>添加图片</Button></Upload>
        </div>
        <div className="canvas-reference-grid">{references.map((item, index) => <div key={item.referenceId} className="canvas-reference-thumb" draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData('text/reference-id', item.referenceId)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); moveReference(event.dataTransfer.getData('text/reference-id'), item.referenceId); }}>
          <button type="button" className="canvas-reference-thumb__preview" onClick={() => setReferencePreviewIndex(index)} aria-label={`预览第 ${index + 1} 张参考图`}><img src={item.url} alt={item.displayName} /><span>{index + 1}</span></button>
          <button type="button" className="canvas-reference-thumb__remove" disabled={readOnly} onClick={() => removeReference(item.referenceId)} aria-label={`移除${item.displayName}`}><CloseCircleFilled /></button>
          <div title={item.displayName}>{item.displayName}</div>
        </div>)}</div>
        {refConfig.promptKey ? <ImeSafeMentions autoSize={{ minRows: 3, maxRows: 8 }} value={referencePrompt} onChange={updateReferencePrompt} disabled={readOnly} placeholder="输入提示词；键入 @ 引用某张参考图" options={references.map((item) => ({ key: item.referenceId, value: `${item.displayName.replace(/\s+/g, '_')}·${item.referenceId.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`, label: <span><img src={item.url} className="canvas-reference-mention-image" />{item.displayName}</span>, reference: item }))} onSelect={(option: any) => {
          const reference = option.reference; const token = `@${option.value}`;
          if (!reference || (data.promptImageReferences || []).some((item) => item.token === token)) return;
          updateNodeData(nodeId, { promptImageReferences: [...(data.promptImageReferences || []), { referenceId: reference.referenceId, sourceNodeId: reference.sourceNodeId, edgeId: reference.edgeId, token, displayName: reference.displayName }] });
        }} /> : null}
        {missingBindings.length ? <Alert type="error" showIcon message={`缺少 ${missingBindings.length} 个提示词引用`} description={missingBindings.map((item) => item.token).join('、')} /> : null}
      </> : null}
      {!data.workflowId ? <Alert type="warning" showIcon message="未绑定工作流" />
        : workflowLoading || run.schemaLoading ? <div style={{ textAlign: 'center', padding: '16px 0' }}><Spin size="small" /><div style={{ color: '#999', marginTop: 6 }}>加载入参表单…</div></div>
        : loadError || run.schemaError ? <Alert type="warning" showIcon message={loadError || run.schemaError} description={data.lastAssets?.length ? '历史结果仍可在结果节点查看。' : undefined} />
        : <ComfySchemaForm schema={run.schema} values={run.formValues} onChange={(key, value) => { run.handleFormChange(key, value); setMissingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; }); }} disabled={readOnly || run.running} exposure={workflow?.exposureConfig ?? null} onUploadImage={readOnly ? undefined : run.uploadImage} uploading={run.uploading} scroll={false} singleColumn invalidKeys={missingKeys} renderInputConnector={renderInputConnector} getConnectedImage={getConnectedImage} getConnectedText={getConnectedText} autoRandomSeedKeys={run.autoRandomSeedKeys} onAutoRandomSeedChange={run.setAutoRandomSeed} onRandomizeSeed={run.randomizeSeed} hiddenFieldKeys={hiddenReferenceKeys} />}
      {missingKeys.size > 0 && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`还有 ${missingKeys.size} 个必填参数未填写`} />}
      {visibleRunState && <div style={{ marginTop: 8 }}>
        {visibleRunning ? <Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /> : null}
        <Tag color={visibleRunState.status === 'success' ? 'success' : visibleRunState.status === 'error' ? 'error' : visibleRunState.status === 'interrupted' ? 'warning' : 'processing'}>{statusLabel[visibleRunState.status] || visibleRunState.status}</Tag>
        {visibleRunState.error ? <div style={{ color: '#ff4d4f', marginTop: 4, wordBreak: 'break-word' }}>{visibleRunState.error}</div> : null}
      </div>}
      {(data.lastAssets ?? []).length ? <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>{(data.lastAssets ?? []).map((asset, assetIndex) => <div key={asset.assetId}><button type="button" className="canvas-media-trigger" onClick={() => setPreviewIndex(assetIndex)} aria-label={`放大预览${asset.kind === 'video' ? '视频' : '图片'}`}>{asset.kind === 'video' ? <><video src={asset.url} muted playsInline preload="metadata" /><PlayCircleFilled className="canvas-media-trigger__play" /></> : <img src={asset.url} alt={asset.filename || '生成图片'} />}</button><AssetIdLabel assetId={asset.assetId} /><Button size="small" block icon={<DownloadOutlined />} href={`/api/assets/${asset.assetId}/download`} download>下载</Button></div>)}</Space> : null}
      <NodeOutputHistory canvasId={canvasId} nodeId={nodeId} kind={outputKind} readOnly={readOnly} control={control} refreshKey={`${historyVersion}:${generationHistoryVersion}`} onSelectAsset={(asset) => updateNodeData(nodeId, { lastAssets: [asset] })} onObserveAsset={(asset) => observeNodeData(nodeId, { lastAssets: [asset] })} onRestoreSeeds={(values) => run.setFormValues((previous) => ({ ...previous, ...values }))} />
    </div>
    <CanvasMediaPreview open={previewIndex !== null} items={(data.lastAssets ?? []).filter((asset): asset is CanvasMediaItem => asset.kind === 'image' || asset.kind === 'video')} index={previewIndex ?? 0} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
    <CanvasMediaPreview open={referencePreviewIndex !== null} items={references.map((item): CanvasMediaItem => ({ assetId: item.assetId, url: item.url, kind: 'image' }))} index={referencePreviewIndex ?? 0} onIndexChange={setReferencePreviewIndex} onClose={() => setReferencePreviewIndex(null)} />
    <Handle type="source" position={Position.Right} id={resultSourceHandle(outputKind)} className={`canvas-handle--${outputKind}`} title={`${outputKind === 'video' ? '视频' : '图片'}输出`} />
  </div>;
}
