import { useContext, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Descriptions, Popconfirm, Space, Tag } from 'antd';
import { DeleteOutlined, ExperimentOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { CanvasNodeDataContext } from '../context';
import { ImeSafeTextArea } from '../ImeSafeInput';
import { resultSourceHandle, resultTargetHandle, type SpeechEvaluatorNodeData } from './types';

export default function SpeechEvaluatorNode(props: NodeProps) {
  const data = props.data as SpeechEvaluatorNodeData;
  const { canvasId, control, readOnly, updateNodeData, deleteNode, getUpstreamAsset, getUpstreamText } = useContext(CanvasNodeDataContext);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const target = getUpstreamAsset(props.id, resultTargetHandle('audio'), 'audio');
  const reference = getUpstreamAsset(props.id, 'reference-audio-target', 'audio');
  const upstreamText = getUpstreamText(props.id, resultTargetHandle('text'));
  const targetText = upstreamText.connected ? upstreamText.text : data.targetText;
  const result = data.lastResult as any;

  const run = async () => {
    if (!canvasId || !control || !target) return; setBusy(true); setError('');
    try {
      const submitted = await request<any>('/api/speech-evaluator/runs', { method: 'POST', data: { canvasId, nodeId: props.id,
        targets: [{ assetId: target.assetId, referenceAssetId: reference?.assetId, targetText }], idempotencyKey: crypto.randomUUID(), ...control } });
      let current = submitted;
      for (let attempt = 0; attempt < 120 && ['queued', 'running'].includes(current.run.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500)); current = await request<any>(`/api/speech-evaluator/runs/${submitted.run.id}`);
      }
      if (current.run.status !== 'succeeded') throw new Error(current.run.error?.message || '语音评价失败');
      updateNodeData(props.id, { lastEvaluationRunId: current.run.id, lastResult: current.items?.[0]?.finalResult, lastText: current.run.outputText });
    } catch (e: any) { setError(e?.response?.data?.message || e?.message || '语音评价失败'); }
    finally { setBusy(false); }
  };

  return <div className={`canvas-node${props.selected ? ' selected' : ''}`}>
    <Handle type="target" position={Position.Left} id={resultTargetHandle('audio')} className="canvas-handle--audio" title="待评价语音" style={{ top: '28%' }} />
    <Handle type="target" position={Position.Left} id="reference-audio-target" className="canvas-handle--audio" title="音色参考（可选）" style={{ top: '40%' }} />
    <Handle type="target" position={Position.Left} id={resultTargetHandle('text')} className="canvas-handle--text" title="目标文本（可选）" style={{ top: '52%' }} />
    <div className="canvas-node__header"><span className="canvas-node__type" style={{ background: '#722ed1' }}>语音评价</span><span className="canvas-node__bind">严格串行</span>
      <Popconfirm title="开始评价这条语音？" okText="评价" cancelText="取消" onConfirm={() => void run()}><Button size="small" type="text" icon={<ExperimentOutlined />} loading={busy} disabled={readOnly || !target} className="nodrag canvas-node__run-action" /></Popconfirm>
      <Popconfirm title="删除该节点？" okText="删除" cancelText="取消" onConfirm={() => deleteNode(props.id)}><Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" /></Popconfirm>
    </div>
    <div className="canvas-node__body nodrag"><Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Tag color={target ? 'success' : 'warning'}>{target ? '已连接待评价语音' : '请连接音频'}</Tag>
      {reference ? <Tag color="purple">已连接音色参考</Tag> : null}
      {!upstreamText.connected ? <ImeSafeTextArea value={data.targetText} onChange={(targetText) => updateNodeData(props.id, { targetText })} disabled={readOnly} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="目标台词（后续用于内容对齐）" /> : <Tag>目标文本来自上游</Tag>}
      {busy ? <Tag color="processing">持有本机重型计算租约并严格串行评价</Tag> : null}
      {result ? <Descriptions size="small" column={1} bordered items={[
        { key: 'score', label: '基础技术分', children: result.technicalScore ?? '—' },
        { key: 'pitch', label: '平均音高', children: result.measurements?.['pitch-energy']?.metrics?.meanF0Hz ? `${result.measurements['pitch-energy'].metrics.meanF0Hz} Hz` : '—' },
        { key: 'pause', label: '静音占比', children: result.measurements?.['pause-timing']?.metrics?.silenceRatio != null ? `${Math.round(result.measurements['pause-timing'].metrics.silenceRatio * 100)}%` : '—' },
        { key: 'status', label: '综合结论', children: result.decision?.status === 'needs_model_evaluation' ? '等待模型评价' : result.decision?.status },
      ]} /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
    </Space></div>
    <Handle type="source" position={Position.Right} id={resultSourceHandle('text')} className="canvas-handle--text" title="结构化评价结果" />
  </div>;
}
