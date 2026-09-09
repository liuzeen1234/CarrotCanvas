import { useContext, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, InputNumber, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { CanvasNodeDataContext } from '../context';
import { ImeSafeInput, ImeSafeTextArea } from '../ImeSafeInput';
import NodeOutputHistory from '../NodeOutputHistory';
import { resultSourceHandle, resultTargetHandle, type TtsNodeData } from './types';
import { confirmComfyTakeover } from '../../comfyui/comfyTakeover';

export default function TtsNode(props: NodeProps) {
  const data = props.data as TtsNodeData;
  const { canvasId, control, readOnly, updateNodeData, observeNodeData, deleteNode, getUpstreamAsset, getUpstreamText, generationHistoryVersion } = useContext(CanvasNodeDataContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const voice = getUpstreamAsset(props.id, resultTargetHandle('audio'), 'audio');
  const emotion = getUpstreamAsset(props.id, 'emotion-audio-target', 'audio');
  const upstreamText = getUpstreamText(props.id, resultTargetHandle('text'));
  const effectiveText = upstreamText.connected ? upstreamText.text : data.text;
  const update = (patch: Partial<TtsNodeData>) => updateNodeData(props.id, patch);

  const run = async () => {
    if (!canvasId || !control || !voice) return;
    setBusy(true); setError('');
    try {
      const idempotencyKey = crypto.randomUUID();
      let result: any = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { result = await request<any>('/api/tts/runs', { method: 'POST', data: {
        provider: data.provider, text: effectiveText, canvasId, nodeId: props.id,
        referenceAssetId: voice.assetId, emotionReferenceAssetId: data.provider === 'indextts2' ? emotion?.assetId : undefined,
        referenceText: data.referenceText, instruction: data.instruction, speed: data.speed,
        idempotencyKey, ...control,
        }}); break; }
        catch (runError) {
          if (attempt === 0 && await confirmComfyTakeover(runError)) continue;
          throw runError;
        }
      }
      if (!result) return;
      update({ lastAssets: [result.asset] });
      setHistoryVersion((value) => value + 1);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || '配音生成失败');
    } finally { setBusy(false); }
  };

  const canRun = !!voice && !!effectiveText.trim() && (data.provider !== 'cosyvoice3' || !!data.referenceText.trim());
  return <div className={`canvas-node${props.selected ? ' selected' : ''}`}>
    <Handle type="target" position={Position.Left} id={resultTargetHandle('audio')} className="canvas-handle--audio" title="音色参考音频" style={{ top: '28%' }} />
    <Handle type="target" position={Position.Left} id="emotion-audio-target" className="canvas-handle--audio" title="情绪参考音频（IndexTTS2）" style={{ top: '38%' }} />
    <Handle type="target" position={Position.Left} id={resultTargetHandle('text')} className="canvas-handle--text" title="配音文本" style={{ top: '50%' }} />
    <div className="canvas-node__header"><span className="canvas-node__type" style={{ background: '#eb2f96' }}>AI 配音</span><span className="canvas-node__bind">{data.provider === 'cosyvoice3' ? 'CosyVoice 3' : 'IndexTTS2'}</span>
      <Popconfirm title="确认生成配音？" okText="生成" cancelText="取消" onConfirm={() => void run()}><Button size="small" type="text" icon={<PlayCircleOutlined />} loading={busy} disabled={readOnly || !canRun} className="nodrag canvas-node__run-action" /></Popconfirm>
      <Popconfirm title="删除该节点？" okText="删除" cancelText="取消" onConfirm={() => deleteNode(props.id)}><Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" /></Popconfirm>
    </div>
    <div className="canvas-node__body nodrag"><Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Select value={data.provider} disabled={readOnly || busy} onChange={(provider) => update({ provider })} options={[{ value: 'cosyvoice3', label: 'CosyVoice 3 · 自然旁白' }, { value: 'indextts2', label: 'IndexTTS2 · 情绪对白' }]} style={{ width: '100%' }} />
      <Tag color={voice ? 'success' : 'warning'}>{voice ? '已连接音色参考' : '请连接音频输入作为音色参考'}</Tag>
      {data.provider === 'indextts2' && emotion ? <Tag color="purple">已连接情绪参考</Tag> : null}
      {upstreamText.connected ? <Typography.Text type="secondary">配音文本来自上游</Typography.Text> : <ImeSafeTextArea value={data.text} onChange={(text) => update({ text })} disabled={readOnly} autoSize={{ minRows: 3, maxRows: 8 }} placeholder="输入需要配音的文本" />}
      {data.provider === 'cosyvoice3' ? <ImeSafeTextArea value={data.referenceText} onChange={(referenceText) => update({ referenceText })} disabled={readOnly} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="参考音频对应的准确文字（必填）" /> : null}
      <ImeSafeInput value={data.instruction} onChange={(instruction) => update({ instruction })} disabled={readOnly} placeholder={data.provider === 'cosyvoice3' ? '风格指令（可选）' : '情绪描述（可选）'} />
      {data.provider === 'cosyvoice3' ? <InputNumber value={data.speed} min={0.5} max={2} step={0.05} disabled={readOnly} onChange={(speed) => update({ speed: speed || 1 })} addonBefore="语速" style={{ width: '100%' }} /> : null}
      {busy ? <Tag color="processing">正在等待本机重型计算资源或生成配音</Tag> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {(data.lastAssets || []).map((asset) => <audio key={asset.assetId} controls src={asset.url} style={{ width: '100%' }} />)}
      <NodeOutputHistory canvasId={canvasId} nodeId={props.id} kind="audio" readOnly={readOnly} control={control} refreshKey={`${historyVersion}:${generationHistoryVersion}`} onSelectAsset={(asset) => update({ lastAssets: [asset] })} onObserveAsset={(asset) => observeNodeData(props.id, { lastAssets: [asset] })} />
    </Space></div>
    <Handle type="source" position={Position.Right} id={resultSourceHandle('audio')} className="canvas-handle--audio" title="音频输出" />
  </div>;
}
