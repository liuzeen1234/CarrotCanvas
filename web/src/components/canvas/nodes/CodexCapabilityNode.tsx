import { useContext, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Image, Popconfirm, Progress, Select, Space, Switch, Tag, Upload } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import { CanvasNodeDataContext } from '../context';
import { capabilityPromptHandle, CodexCapabilityNodeData, promptPartSourceHandle, resultSourceHandle, resultTargetHandle } from './types';
import { CodexImageResponse, errorMessage, imageSource, postForm, postJson, streamChat } from '@/components/codex2api/client';
import { ImeSafeTextArea } from '../ImeSafeInput';
import NodeOutputHistory from '../NodeOutputHistory';

const LABELS = { text: '文生文', image: '文生图', edit: '图生图', analyze: '图像理解' } as const;

export default function CodexCapabilityNode(props: NodeProps) {
  const data = props.data as CodexCapabilityNodeData;
  const { canvasId, control, readOnly, updateNodeData, deleteNode, getUpstreamAsset, getUpstreamText } = useContext(CanvasNodeDataContext);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [liveText, setLiveText] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const needsImage = data.capability === 'edit' || data.capability === 'analyze';
  const outputKind = data.capability === 'text' || data.capability === 'analyze' ? 'text' : 'image';
  const supportsPromptMode = data.capability === 'text' || data.capability === 'analyze';
  const promptPairMode = supportsPromptMode && (data.outputMode === 'image-prompts' || data.outputMode === 'video-prompts');
  const upstream = needsImage ? getUpstreamAsset(props.id, resultTargetHandle('image'), 'image') : null;
  const upstreamPrompt = getUpstreamText(props.id, capabilityPromptHandle());
  const effectivePrompt = upstreamPrompt.connected ? upstreamPrompt.text : data.prompt;
  const images = data.lastAssets || [];
  const displayedText = liveText || data.lastText || '';

  const update = (patch: Partial<CodexCapabilityNodeData>) => updateNodeData(props.id, patch);
  const imageFile = async () => {
    if (files[0]?.originFileObj) return files[0].originFileObj;
    if (upstream?.url) {
      const response = await fetch(upstream.url);
      if (!response.ok) throw new Error('无法读取上游图片');
      return new File([await response.blob()], upstream.filename || 'upstream.png', { type: response.headers.get('content-type') || 'image/png' });
    }
    throw new Error('请上传图片或连接一个图片输出');
  };
  const run = async () => {
    if (readOnly) return;
    setBusy(true); setError(''); setLiveText('');
    const controller = new AbortController(); abortRef.current = controller;
    // 图片生成完成后，后端还需要把结果捕获进画布资产库；给该步骤留出余量。
    const timer = window.setTimeout(() => controller.abort(), 600_000);
    try {
      if (data.capability === 'text') {
        const body = { model: data.model || 'codex', messages: [{ role: 'user', content: effectivePrompt }], carrotOutputMode: promptPairMode ? data.outputMode : 'text', canvasId, nodeId: props.id, idempotencyKey: crypto.randomUUID(), ...control };
        let text = '';
        let parts: { positive: string; negative: string } | undefined;
        if (!promptPairMode && data.stream !== false) await streamChat(body, (delta) => { text += delta; setLiveText(text); }, controller.signal);
        else { const result = await postJson<any>('/api/codex2api/chat/completions', { ...body, stream: false }, controller.signal); text = result?.choices?.[0]?.message?.content || ''; parts = result?.outputParts || undefined; setLiveText(text); }
        update({ lastText: text, lastTextParts: parts });
      } else if (data.capability === 'image') {
        const result = await postJson<CodexImageResponse>('/api/codex2api/images/generations', { prompt: effectivePrompt, model: data.model || 'codex', n: 1, size: data.size, response_format: data.responseFormat, canvasId, nodeId: props.id, idempotencyKey: crypto.randomUUID(), ...control }, controller.signal);
        update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) });
      } else {
        const form = new FormData(); form.append('image', await imageFile()); form.append('prompt', effectivePrompt); form.append('model', data.model || 'codex'); form.append('idempotencyKey', crypto.randomUUID()); if (promptPairMode) form.append('carrotOutputMode', data.outputMode!); if (canvasId) form.append('canvasId', canvasId); form.append('nodeId', props.id); if (control) { form.append('leaseToken', control.leaseToken); form.append('leaseEpoch', String(control.leaseEpoch)); form.append('expectedRevision', String(control.expectedRevision)); }
        if (data.capability === 'edit') { form.append('n', '1'); form.append('size', data.size || '1024x1024'); form.append('response_format', data.responseFormat || 'url'); const result = await postForm<CodexImageResponse>('/api/codex2api/images/edits', form, controller.signal); update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) }); }
        else { const result = await postForm<any>('/api/codex2api/images/analyze', form, controller.signal); update({ lastText: result.text || result.data?.[0]?.text || result.choices?.[0]?.message?.content || '', lastTextParts: result.outputParts || undefined }); }
      }
      setHistoryVersion((value) => value + 1);
    } catch (e) { setError(errorMessage(e)); } finally { clearTimeout(timer); setBusy(false); abortRef.current = null; }
  };

  const canRun = !!effectivePrompt?.trim() && (!needsImage || !!files.length || !!upstream);
  return <div className={`canvas-node canvas-node--codex${props.selected ? ' selected' : ''}`}>
    {needsImage ? <Handle type="target" position={Position.Left} id={resultTargetHandle('image')} className="canvas-handle--image" title="图片输入" /> : null}
    <div className="canvas-node__header"><span className="canvas-node__type" style={{ background: '#fa8c16' }}>Codex2API</span><span className="canvas-node__bind">{LABELS[data.capability]}</span>
      <Popconfirm title="确认运行该节点？" description="运行可能消耗 API 额度并需要一定时间。" okText="确认运行" cancelText="取消" onConfirm={() => void run()}>
        <Button size="small" type="text" icon={<PlayCircleOutlined />} loading={busy} disabled={readOnly || !canRun} className="nodrag canvas-node__run-action" aria-label="运行节点" />
      </Popconfirm>
      <Popconfirm title="删除该节点？" okText="删除" cancelText="取消" onConfirm={() => deleteNode(props.id)}><Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" aria-label="删除节点" /></Popconfirm>
    </div>
    <div className="canvas-node__body nodrag"><Space direction="vertical" size={8} style={{ width: '100%' }}>
      {needsImage ? <Upload disabled={readOnly} accept="image/*" maxCount={1} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => setFiles(fileList.slice(-1))} listType="picture"><Button disabled={readOnly} icon={<UploadOutlined />}>{upstream ? '改用本地图片' : '上传图片'}</Button></Upload> : null}
      {upstream ? <Tag color="success">已连接上游图片</Tag> : null}
      <div style={{ position: 'relative' }}>
        <Handle type="target" position={Position.Left} id={capabilityPromptHandle()} className="canvas-handle--text" style={{ left: -15 }} title="提示词文本输入" />
        <ImeSafeTextArea autoSize={{ minRows: 3, maxRows: 8 }} value={upstreamPrompt.connected ? upstreamPrompt.text : data.prompt} onChange={(prompt) => update({ prompt })} disabled={readOnly || upstreamPrompt.connected} placeholder={upstreamPrompt.connected ? '等待上游输出文本' : '输入提示词'} />
      </div>
      {upstreamPrompt.connected ? <Tag color={upstreamPrompt.text.trim() ? 'success' : 'warning'}>{upstreamPrompt.text.trim() ? '已连接上游提示词' : '上游尚未输出文本'}</Tag> : null}
      <Select disabled={readOnly} size="small" value={data.model || 'codex'} options={[{ value: 'codex', label: 'codex' }]} onChange={(model) => update({ model })} style={{ width: '100%' }} />
      {supportsPromptMode ? <Select disabled={readOnly} size="small" value={data.outputMode || 'text'} options={[{ value: 'text', label: '普通文本' }, { value: 'image-prompts', label: '图像提示词（正负分开）' }, { value: 'video-prompts', label: '视频提示词（正负分开）' }]} onChange={(outputMode) => update({ outputMode, lastTextParts: outputMode === 'text' ? undefined : data.lastTextParts })} style={{ width: '100%' }} /> : null}
      {data.capability === 'text' && !promptPairMode ? <Switch disabled={readOnly} size="small" checked={data.stream !== false} checkedChildren="流式" unCheckedChildren="普通" onChange={(stream) => update({ stream })} /> : null}
      {promptPairMode ? <Tag color={data.outputMode === 'video-prompts' ? 'purple' : 'blue'}>{data.outputMode === 'video-prompts' ? '视频提示词' : '图像提示词'} · 输出：合并 / 正向 / 负向</Tag> : null}
      {data.capability === 'image' || data.capability === 'edit' ? <Space.Compact block><Select disabled={readOnly} size="small" value={data.size} options={['1024x1024','1536x1024','1024x1536'].map((value) => ({ value, label: value }))} onChange={(size) => update({ size })} style={{ width: '60%' }} /><Select disabled={readOnly} size="small" value={data.responseFormat} options={[{ value: 'url', label: 'URL' },{ value: 'b64_json', label: 'Base64' }]} onChange={(responseFormat) => update({ responseFormat })} style={{ width: '40%' }} /></Space.Compact> : null}
      {busy ? <div><Progress percent={70} status="active" showInfo={false} /><Tag color="processing">{data.capability === 'text' ? '正在生成文字' : data.capability === 'analyze' ? '正在理解图片' : data.capability === 'edit' ? '正在编辑图片' : '正在生成图片'}</Tag></div> : null}{error ? <Alert type="error" showIcon message={error} /> : null}
      {displayedText ? <div className="canvas-codex-text">{displayedText}</div> : null}
      {images.map((item, index) => <div key={`${item.url}-${index}`}><Image src={item.url} width="100%" /><Button size="small" block icon={<DownloadOutlined />} href={item.assetId ? `/api/assets/${item.assetId}/download` : item.url} download>下载</Button></div>)}
      <NodeOutputHistory canvasId={canvasId} nodeId={props.id} kind={outputKind} readOnly={readOnly} control={control} refreshKey={historyVersion} onSelectAsset={(asset) => update({ lastAssets: [asset] })} onSelectText={(text, parts) => { setLiveText(''); update({ lastText: text, lastTextParts: parts || undefined }); }} />
    </Space></div>
    <Handle type="source" position={Position.Right} id={resultSourceHandle(outputKind)} className={`canvas-handle--${outputKind}`} title={promptPairMode ? '合并提示词输出' : `${outputKind === 'image' ? '图片' : '文本'}输出`} style={promptPairMode ? { top: '62%' } : undefined} />
    {promptPairMode ? <><Handle type="source" position={Position.Right} id={promptPartSourceHandle('positive')} className="canvas-handle--text" title="正向提示词输出" style={{ top: '72%' }} /><Handle type="source" position={Position.Right} id={promptPartSourceHandle('negative')} className="canvas-handle--text" title="负向提示词输出" style={{ top: '82%' }} /></> : null}
  </div>;
}
