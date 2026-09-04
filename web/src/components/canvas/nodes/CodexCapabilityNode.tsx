import { useContext, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Image, Input, Popconfirm, Select, Space, Switch, Tag, Tooltip, Upload, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import { CanvasNodeDataContext } from '../context';
import { CodexCapabilityNodeData, resultSourceHandle, resultTargetHandle } from './types';
import { CodexImageResponse, errorMessage, imageSource, postForm, postJson, streamChat } from '@/components/codex2api/client';

const LABELS = { text: '文生文', image: '文生图', edit: '图生图', analyze: '图像理解' } as const;

export default function CodexCapabilityNode(props: NodeProps) {
  const data = props.data as CodexCapabilityNodeData;
  const { canvasId, updateNodeData, deleteNode, getUpstreamAsset } = useContext(CanvasNodeDataContext);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [liveText, setLiveText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const needsImage = data.capability === 'edit' || data.capability === 'analyze';
  const outputKind = data.capability === 'text' || data.capability === 'analyze' ? 'text' : 'image';
  const upstream = needsImage ? getUpstreamAsset(props.id, resultTargetHandle('image'), 'image') : null;
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
    setBusy(true); setError(''); setLiveText('');
    const controller = new AbortController(); abortRef.current = controller;
    // 图片生成完成后，后端还需要把结果捕获进画布资产库；给该步骤留出余量。
    const timer = window.setTimeout(() => controller.abort(), 600_000);
    try {
      if (data.capability === 'text') {
        const body = { model: data.model || 'codex', messages: [{ role: 'user', content: data.prompt }] };
        let text = '';
        if (data.stream !== false) await streamChat(body, (delta) => { text += delta; setLiveText(text); }, controller.signal);
        else { const result = await postJson<any>('/api/codex2api/chat/completions', { ...body, stream: false }, controller.signal); text = result?.choices?.[0]?.message?.content || ''; setLiveText(text); }
        update({ lastText: text });
      } else if (data.capability === 'image') {
        const result = await postJson<CodexImageResponse>('/api/codex2api/images/generations', { prompt: data.prompt, model: data.model || 'codex', n: 1, size: data.size, response_format: data.responseFormat, canvasId, nodeId: props.id }, controller.signal);
        update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) });
      } else {
        const form = new FormData(); form.append('image', await imageFile()); form.append('prompt', data.prompt); form.append('model', data.model || 'codex');
        if (data.capability === 'edit') { form.append('n', '1'); form.append('size', data.size || '1024x1024'); form.append('response_format', data.responseFormat || 'url'); if (canvasId) form.append('canvasId', canvasId); form.append('nodeId', props.id); const result = await postForm<CodexImageResponse>('/api/codex2api/images/edits', form, controller.signal); update({ lastAssets: result.data.map((item) => ({ assetId: item.assetId || '', url: imageSource(item), kind: 'image' })) }); }
        else { const result = await postForm<any>('/api/codex2api/images/analyze', form, controller.signal); update({ lastText: result.text || result.data?.[0]?.text || '' }); }
      }
    } catch (e) { setError(errorMessage(e)); } finally { clearTimeout(timer); setBusy(false); abortRef.current = null; }
  };

  const canRun = !!data.prompt?.trim() && (!needsImage || !!files.length || !!upstream);
  return <div className={`canvas-node canvas-node--codex${props.selected ? ' selected' : ''}`}>
    {needsImage ? <Handle type="target" position={Position.Left} id={resultTargetHandle('image')} className="canvas-handle--image" title="图片输入" /> : null}
    <div className="canvas-node__header"><span className="canvas-node__type" style={{ background: '#fa8c16' }}>Codex2API</span><span className="canvas-node__bind">{LABELS[data.capability]}</span>
      <Tooltip title="运行"><Button size="small" type="text" icon={<PlayCircleOutlined />} loading={busy} disabled={!canRun} className="nodrag" onClick={() => void run()} /></Tooltip>
      <Popconfirm title="删除该节点？" okText="删除" cancelText="取消" onConfirm={() => deleteNode(props.id)}><Button size="small" type="text" danger icon={<DeleteOutlined />} className="nodrag" /></Popconfirm>
    </div>
    <div className="canvas-node__body nodrag"><Space direction="vertical" size={8} style={{ width: '100%' }}>
      {needsImage ? <Upload accept="image/*" maxCount={1} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => setFiles(fileList.slice(-1))} listType="picture"><Button icon={<UploadOutlined />}>{upstream ? '改用本地图片' : '上传图片'}</Button></Upload> : null}
      {upstream ? <Tag color="success">已连接上游图片</Tag> : null}
      <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} value={data.prompt} onChange={(e) => update({ prompt: e.target.value })} placeholder="输入提示词" />
      <Select size="small" value={data.model || 'codex'} options={[{ value: 'codex', label: 'codex' }]} onChange={(model) => update({ model })} style={{ width: '100%' }} />
      {data.capability === 'text' ? <Switch size="small" checked={data.stream !== false} checkedChildren="流式" unCheckedChildren="普通" onChange={(stream) => update({ stream })} /> : null}
      {data.capability === 'image' || data.capability === 'edit' ? <Space.Compact block><Select size="small" value={data.size} options={['1024x1024','1536x1024','1024x1536'].map((value) => ({ value, label: value }))} onChange={(size) => update({ size })} style={{ width: '60%' }} /><Select size="small" value={data.responseFormat} options={[{ value: 'url', label: 'URL' },{ value: 'b64_json', label: 'Base64' }]} onChange={(responseFormat) => update({ responseFormat })} style={{ width: '40%' }} /></Space.Compact> : null}
      {busy ? <Tag color="processing">{data.capability === 'text' ? '正在输出' : '正在处理'}</Tag> : null}{error ? <Alert type="error" showIcon message={error} /> : null}
      {displayedText ? <div className="canvas-codex-text">{displayedText}</div> : null}
      {images.map((item, index) => <div key={`${item.url}-${index}`}><Image src={item.url} width="100%" /><Button size="small" block icon={<DownloadOutlined />} href={item.assetId ? `/api/assets/${item.assetId}/download` : item.url} download>下载</Button></div>)}
    </Space></div>
    <Handle type="source" position={Position.Right} id={resultSourceHandle(outputKind)} className={`canvas-handle--${outputKind}`} title={`${outputKind === 'image' ? '图片' : '文本'}输出`} />
  </div>;
}
