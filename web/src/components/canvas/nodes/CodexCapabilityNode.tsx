import { useContext, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Popconfirm, Progress, Select, Space, Switch, Tag, Typography, Upload, message } from 'antd';
import { CloseCircleFilled, DeleteOutlined, DownloadOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import { CanvasNodeDataContext } from '../context';
import { capabilityPromptHandle, CodexCapabilityNodeData, promptPartSourceHandle, resultSourceHandle, resultTargetHandle } from './types';
import { CodexImageResponse, errorMessage, imageSource, postForm, postJson, streamChat } from '@/components/codex2api/client';
import { ImeSafeMentions, ImeSafeTextArea } from '../ImeSafeInput';
import NodeOutputHistory from '../NodeOutputHistory';
import { RunElapsed } from '../RunTiming';
import CanvasMediaPreview, { type CanvasMediaItem } from '../CanvasMediaPreview';
import { createClientUuid } from '@/utils/uuid';
import { AssetIdLabel, NodeCardFields } from './NodeCardFields';

const LABELS = { text: '文生文', image: '文生图', edit: '图生图', analyze: '图像理解' } as const;
const MAX_REFERENCE_IMAGES = 16;

export default function CodexCapabilityNode(props: NodeProps) {
  const data = props.data as CodexCapabilityNodeData;
  const { canvasId, control, readOnly, updateNodeData, observeNodeData, deleteNode, getNodeRunState, getUpstreamAssets, disconnectEdge, getUpstreamText, generationHistoryVersion } = useContext(CanvasNodeDataContext);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [liveText, setLiveText] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const needsImage = data.capability === 'edit' || data.capability === 'analyze';
  const outputKind = data.capability === 'text' || data.capability === 'analyze' ? 'text' : 'image';
  const supportsPromptMode = data.capability === 'text' || data.capability === 'analyze';
  const promptPairMode = supportsPromptMode && (data.outputMode === 'image-prompts' || data.outputMode === 'video-prompts');
  const reversePromptMode = data.capability === 'analyze' && data.outputMode === 'image-prompts';
  const connectedReferences = needsImage ? getUpstreamAssets(props.id, resultTargetHandle('image'), 'image') : [];
  const uploadedReferences = data.referenceImages || [];
  const referenceOrder = data.referenceImageOrder || [];
  const references = useMemo(() => [...connectedReferences, ...uploadedReferences].sort((a, b) => {
    const ai = referenceOrder.indexOf(a.referenceId), bi = referenceOrder.indexOf(b.referenceId);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  }), [connectedReferences, uploadedReferences, referenceOrder]);
  const upstreamPrompt = getUpstreamText(props.id, capabilityPromptHandle());
  const textTransformMode = data.capability === 'text' && upstreamPrompt.connected;
  const effectivePrompt = upstreamPrompt.connected
    ? (needsImage ? [upstreamPrompt.text, data.prompt.trim() ? `补充要求：\n${data.prompt}` : ''].filter(Boolean).join('\n\n') : upstreamPrompt.text)
    : data.prompt;
  const images = data.lastAssets || [];
  const displayedText = liveText || data.lastText || '';
  const sharedRun = getNodeRunState(props.id);

  const update = (patch: Partial<CodexCapabilityNodeData>) => updateNodeData(props.id, patch);
  const activeBindings = (data.promptImageReferences || []).filter((binding) => data.prompt.includes(binding.token));
  const missingBindings = activeBindings.filter((binding) => !references.some((item) => item.referenceId === binding.referenceId));
  const imageFiles = async () => Promise.all(references.map(async (reference, index) => {
      const response = await fetch(reference.url);
      if (!response.ok) throw new Error('无法读取上游图片');
      return new File([await response.blob()], reference.filename || `reference-${index + 1}.png`, { type: response.headers.get('content-type') || 'image/png' });
    }));
  const compilePrompt = (prompt: string) => {
    let compiled = prompt;
    for (const binding of activeBindings) {
      const index = references.findIndex((item) => item.referenceId === binding.referenceId);
      if (index >= 0) compiled = compiled.split(binding.token).join(`第 ${index + 1} 张输入图片（${binding.displayName}）`);
    }
    const legend = references.map((item, index) => `第 ${index + 1} 张：${item.displayName}`).join('\n');
    return legend ? `输入图片顺序：\n${legend}\n\n${compiled}` : compiled;
  };
  const updatePrompt = (prompt: string) => update({ prompt, promptImageReferences: (data.promptImageReferences || []).filter((binding) => prompt.includes(binding.token)) });
  const removeReference = (referenceId: string) => {
    const binding = activeBindings.find((item) => item.referenceId === referenceId);
    if (binding) { message.error(`“${binding.displayName}”仍被提示词引用，请先删除 ${binding.token}`); return; }
    const connected = connectedReferences.find((item) => item.referenceId === referenceId);
    if (connected) { update({ referenceImageOrder: referenceOrder.filter((id) => id !== referenceId) }); disconnectEdge(connected.edgeId); }
    else update({ referenceImages: uploadedReferences.filter((item) => item.referenceId !== referenceId), referenceImageOrder: referenceOrder.filter((id) => id !== referenceId) });
  };
  const moveReference = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const current = references.map((item) => item.referenceId);
    const from = current.indexOf(fromId), to = current.indexOf(toId);
    if (from < 0 || to < 0) return;
    const [moved] = current.splice(from, 1); current.splice(to, 0, moved);
    update({ referenceImageOrder: current });
  };
  const uploadReference = async (file: File) => {
    if (!canvasId || !control) { message.error('当前画布不可写'); return false; }
    if (references.length >= MAX_REFERENCE_IMAGES) { message.error('参考图片最多 16 张'); return false; }
    const form = new FormData(); form.append('file', file); form.append('kind', 'image'); form.append('canvasId', canvasId); form.append('nodeId', props.id);
    form.append('leaseToken', control.leaseToken); form.append('leaseEpoch', String(control.leaseEpoch)); form.append('expectedRevision', String(control.expectedRevision));
    try {
      const response = await fetch('/api/comfyui/upload/media', { method: 'POST', body: form });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || '上传失败');
      const { asset } = await response.json(); const referenceId = `asset:${asset.assetId}`;
      update({ referenceImages: [...uploadedReferences, { referenceId, ...asset, displayName: asset.filename || file.name }], referenceImageOrder: [...referenceOrder.filter((id) => references.some((item) => item.referenceId === id)), referenceId] });
    } catch (cause) { message.error(errorMessage(cause)); }
    return false;
  };
  const run = async () => {
    if (readOnly) return;
    setLocalStartedAt(Date.now());
    setBusy(true); setError(''); setLiveText('');
    const controller = new AbortController(); abortRef.current = controller;
    // 图片生成完成后，后端还需要把结果捕获进画布资产库；给该步骤留出余量。
    const timer = window.setTimeout(() => controller.abort(), 600_000);
    try {
      if (data.capability === 'text') {
        const body = {
          model: data.model || 'codex',
          messages: [{ role: 'user', content: effectivePrompt }],
          ...(textTransformMode ? { carrotInputText: upstreamPrompt.text, carrotInstruction: data.prompt } : {}),
          carrotOutputMode: promptPairMode ? data.outputMode : 'text', canvasId, nodeId: props.id, idempotencyKey: createClientUuid(), ...control,
        };
        let text = '';
        let parts: { positive: string; negative: string } | undefined;
        if (!promptPairMode && data.stream !== false) await streamChat(body, (delta) => { text += delta; setLiveText(text); }, controller.signal);
        else { const result = await postJson<any>('/api/codex2api/chat/completions', { ...body, stream: false }, controller.signal); text = result?.choices?.[0]?.message?.content || ''; parts = result?.outputParts || undefined; setLiveText(text); }
        update({ lastText: text, lastTextParts: parts });
      } else if (data.capability === 'image') {
        const result = await postJson<CodexImageResponse>('/api/codex2api/images/generations', { prompt: effectivePrompt, model: data.model || 'codex', n: 1, size: data.size, response_format: data.responseFormat, canvasId, nodeId: props.id, idempotencyKey: createClientUuid(), ...control }, controller.signal);
        update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) });
      } else {
        if (missingBindings.length) throw new Error('提示词中存在已缺失的图片引用，请先解除或重新连接');
        const form = new FormData(); for (const file of await imageFiles()) form.append('image', file); form.append('prompt', compilePrompt(effectivePrompt)); form.append('inputAssetIds', JSON.stringify(references.map((item) => item.assetId).filter(Boolean))); form.append('imageReferenceMap', JSON.stringify(references.map((item, index) => ({ referenceId: item.referenceId, assetId: item.assetId, position: index + 1, displayName: item.displayName })))); form.append('originalPrompt', effectivePrompt); form.append('model', data.model || 'codex'); form.append('idempotencyKey', createClientUuid()); if (promptPairMode) form.append('carrotOutputMode', data.outputMode!); if (canvasId) form.append('canvasId', canvasId); form.append('nodeId', props.id); if (control) { form.append('leaseToken', control.leaseToken); form.append('leaseEpoch', String(control.leaseEpoch)); form.append('expectedRevision', String(control.expectedRevision)); }
        if (data.capability === 'edit') { form.append('n', '1'); form.append('size', data.size || '1024x1024'); form.append('response_format', data.responseFormat || 'url'); const result = await postForm<CodexImageResponse>('/api/codex2api/images/edits', form, controller.signal); update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) }); }
        else { const result = await postForm<any>('/api/codex2api/images/analyze', form, controller.signal); update({ lastText: result.text || result.data?.[0]?.text || result.choices?.[0]?.message?.content || '', lastTextParts: result.outputParts || undefined }); }
      }
      setHistoryVersion((value) => value + 1);
    } catch (e) { setError(errorMessage(e)); } finally { clearTimeout(timer); setBusy(false); setLocalStartedAt(null); abortRef.current = null; }
  };

  const canRun = !!effectivePrompt?.trim() && (!upstreamPrompt.connected || !!upstreamPrompt.text.trim()) && (!textTransformMode || !!data.prompt.trim()) && (!needsImage || references.length > 0) && !missingBindings.length;
  return <div className={`canvas-node canvas-node--codex${props.selected ? ' selected' : ''}${missingBindings.length ? ' canvas-node--reference-error' : ''}`}>
    {needsImage ? <Handle type="target" position={Position.Left} id={resultTargetHandle('image')} className="canvas-handle--image" title="图片输入" /> : null}
    <div className="canvas-node__header"><span className="canvas-node__type" style={{ background: '#fa8c16' }}>Codex2API</span><span className="canvas-node__bind" title={data.cardName || LABELS[data.capability]}>{data.cardName || LABELS[data.capability]}</span>
      <RunElapsed status={sharedRun?.status ?? (busy ? 'running' : undefined)} queuedAt={sharedRun?.queuedAt ?? localStartedAt} startedAt={sharedRun?.startedAt ?? localStartedAt} />
      <Popconfirm title="确认运行该节点？" description="运行可能消耗 API 额度并需要一定时间。" okText="确认运行" cancelText="取消" onConfirm={() => void run()}>
        <Button size="small" type="text" icon={<PlayCircleOutlined />} loading={busy} disabled={readOnly || !canRun} className="nodrag canvas-node__run-action" aria-label="运行节点" />
      </Popconfirm>
      <Popconfirm title="删除该节点？" okText="删除" cancelText="取消" onConfirm={() => deleteNode(props.id)}><Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" aria-label="删除节点" /></Popconfirm>
    </div>
    <div className="canvas-node__body nodrag"><Space direction="vertical" size={8} style={{ width: '100%' }}>
      <NodeCardFields name={data.cardName} note={data.note} readOnly={readOnly} onChange={update} />
      {needsImage ? <>
        <div className="canvas-reference-summary"><Typography.Text strong>参考图 {references.length} / {MAX_REFERENCE_IMAGES}</Typography.Text><Upload disabled={readOnly || references.length >= MAX_REFERENCE_IMAGES} accept="image/*" multiple showUploadList={false} beforeUpload={uploadReference}><Button size="small" disabled={readOnly || references.length >= MAX_REFERENCE_IMAGES} icon={<UploadOutlined />}>添加图片</Button></Upload></div>
        <div className="canvas-reference-grid">{references.map((item, index) => <div key={item.referenceId} className="canvas-reference-thumb" draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData('text/reference-id', item.referenceId)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); moveReference(event.dataTransfer.getData('text/reference-id'), item.referenceId); }}>
          <button type="button" className="canvas-reference-thumb__preview" onClick={() => setPreviewIndex(index)} aria-label={`预览第 ${index + 1} 张参考图`}><img src={item.url} alt={item.displayName} /><span>{index + 1}</span></button>
          <button type="button" className="canvas-reference-thumb__remove" disabled={readOnly} onClick={() => removeReference(item.referenceId)} aria-label={`移除${item.displayName}`}><CloseCircleFilled /></button>
          <div title={item.displayName}>{item.displayName}</div>
        </div>)}</div>
        {missingBindings.length ? <Alert type="error" showIcon message={`缺少 ${missingBindings.length} 个提示词引用`} description={missingBindings.map((item) => item.token).join('、')} /> : null}
      </> : null}
      {textTransformMode ? <div className="canvas-codex-input-text">
        <Typography.Text type="secondary">输入文本（来自上游）</Typography.Text>
        <div className="canvas-codex-input-text__content">{upstreamPrompt.text || '上游尚未输出文本'}</div>
      </div> : null}
      <div style={{ position: 'relative' }}>
        <Handle type="target" position={Position.Left} id={capabilityPromptHandle()} className="canvas-handle--text" style={{ left: -15 }} title="提示词文本输入" />
        {textTransformMode ? <Typography.Text type="secondary">加工要求</Typography.Text> : null}
        {needsImage ? <ImeSafeMentions autoSize={{ minRows: 3, maxRows: 8 }} value={data.prompt} onChange={updatePrompt} disabled={readOnly} placeholder="输入提示词；键入 @ 引用某张参考图" options={references.map((item) => ({ key: item.referenceId, value: `${item.displayName.replace(/\s+/g, '_')}·${item.referenceId.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`, label: <span><img src={item.url} className="canvas-reference-mention-image" />{item.displayName}</span>, reference: item }))} onSelect={(option: any) => {
          const reference = option.reference; const token = `@${option.value}`;
          if (!reference || (data.promptImageReferences || []).some((item) => item.token === token)) return;
          update({ promptImageReferences: [...(data.promptImageReferences || []), { referenceId: reference.referenceId, sourceNodeId: reference.sourceNodeId, edgeId: reference.edgeId, token, displayName: reference.displayName }] });
        }} /> : <ImeSafeTextArea autoSize={{ minRows: 3, maxRows: 8 }} value={data.prompt} onChange={updatePrompt} disabled={readOnly} placeholder={textTransformMode ? '输入如何修改上游文本，例如：压缩篇幅并改写为分镜脚本' : upstreamPrompt.connected ? '等待上游输出文本' : '输入提示词'} />}
      </div>
      {upstreamPrompt.connected ? <Tag color={upstreamPrompt.text.trim() ? 'success' : 'warning'}>{upstreamPrompt.text.trim() ? (textTransformMode ? '已连接上游输入' : '已连接上游提示词') : '上游尚未输出文本'}</Tag> : null}
      <Select disabled={readOnly} size="small" value={data.model || 'codex'} options={[{ value: 'codex', label: 'codex' }]} onChange={(model) => update({ model })} style={{ width: '100%' }} />
      {supportsPromptMode ? <Select disabled={readOnly} size="small" value={data.outputMode || 'text'} options={[{ value: 'text', label: '普通文本' }, { value: 'image-prompts', label: data.capability === 'analyze' ? '图片提示词反推（正负分开）' : '图像提示词（正负分开）' }, { value: 'video-prompts', label: '视频提示词（正负分开）' }]} onChange={(outputMode) => update({ outputMode, lastTextParts: outputMode === 'text' ? undefined : data.lastTextParts })} style={{ width: '100%' }} /> : null}
      {data.capability === 'text' && !promptPairMode ? <Switch disabled={readOnly} size="small" checked={data.stream !== false} checkedChildren="流式" unCheckedChildren="普通" onChange={(stream) => update({ stream })} /> : null}
      {promptPairMode ? <Tag color={data.outputMode === 'video-prompts' ? 'purple' : 'blue'}>{data.outputMode === 'video-prompts' ? '视频提示词' : reversePromptMode ? '图片提示词反推' : '图像提示词'} · 输出：合并 / 正向 / 负向</Tag> : null}
      {reversePromptMode ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>用于近似复现画面；无法恢复原始 Prompt、模型、seed、LoRA 等不可见参数。</Typography.Text> : null}
      {data.capability === 'image' || data.capability === 'edit' ? <Space.Compact block><Select disabled={readOnly} size="small" value={data.size} options={['1024x1024','1536x1024','1024x1536'].map((value) => ({ value, label: value }))} onChange={(size) => update({ size })} style={{ width: '60%' }} /><Select disabled={readOnly} size="small" value={data.responseFormat} options={[{ value: 'url', label: 'URL' },{ value: 'b64_json', label: 'Base64' }]} onChange={(responseFormat) => update({ responseFormat })} style={{ width: '40%' }} /></Space.Compact> : null}
      {busy ? <div><Progress percent={70} status="active" showInfo={false} /><Tag color="processing">{data.capability === 'text' ? '正在生成文字' : reversePromptMode ? '正在反推图片提示词' : data.capability === 'analyze' ? '正在理解图片' : data.capability === 'edit' ? '正在编辑图片' : '正在生成图片'}</Tag></div> : null}{error ? <Alert type="error" showIcon message={error} /> : null}
      {displayedText ? <div className="canvas-codex-text">{displayedText}</div> : null}
      {images.map((item, index) => <div key={`${item.url}-${index}`}><button type="button" className="canvas-media-trigger" onClick={() => setPreviewIndex(index)} aria-label="放大预览图片"><img src={item.url} alt="生成图片" /></button><AssetIdLabel assetId={item.assetId} /><Button size="small" block icon={<DownloadOutlined />} href={item.assetId ? `/api/assets/${item.assetId}/download` : item.url} download>下载</Button></div>)}
      <NodeOutputHistory canvasId={canvasId} nodeId={props.id} kind={outputKind} promptModeContext={data.capability} readOnly={readOnly} control={control} refreshKey={`${historyVersion}:${generationHistoryVersion}`} onSelectAsset={(asset) => update({ lastAssets: [asset] })} onSelectText={(text, parts) => { setLiveText(''); update({ lastText: text, lastTextParts: parts || undefined }); }} onObserveAsset={(asset) => observeNodeData(props.id, { lastAssets: [asset] })} onObserveText={(text, parts) => { setLiveText(''); observeNodeData(props.id, { lastText: text, lastTextParts: parts || undefined }); }} />
    </Space></div>
    <CanvasMediaPreview open={previewIndex !== null} items={(needsImage ? references : images).map((item): CanvasMediaItem => ({ assetId: item.assetId || '', url: item.url, kind: 'image' }))} index={previewIndex ?? 0} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
    <Handle type="source" position={Position.Right} id={resultSourceHandle(outputKind)} className={`canvas-handle--${outputKind}`} title={promptPairMode ? '合并提示词输出' : `${outputKind === 'image' ? '图片' : '文本'}输出`} style={promptPairMode ? { top: '62%' } : undefined} />
    {promptPairMode ? <><Handle type="source" position={Position.Right} id={promptPartSourceHandle('positive')} className="canvas-handle--text" title="正向提示词输出" style={{ top: '72%' }} /><Handle type="source" position={Position.Right} id={promptPartSourceHandle('negative')} className="canvas-handle--text" title="负向提示词输出" style={{ top: '82%' }} /></> : null}
  </div>;
}
