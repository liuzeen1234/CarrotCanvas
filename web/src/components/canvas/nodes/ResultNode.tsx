/** C6 结果节点：通过连线读取上游运行态与平台资产，不冗余持久化引用。 */
import { useContext, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Empty, Popconfirm, Progress, Space, Spin } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlayCircleFilled } from '@ant-design/icons';
import { CanvasNodeDataContext } from '../context';
import CanvasMediaPreview, { type CanvasMediaItem } from '../CanvasMediaPreview';
import { ResultNodeData, resultSourceHandle, resultTargetHandle } from './types';

export default function ResultNode(props: NodeProps) {
  const { readOnly, deleteNode, getResultState } = useContext(CanvasNodeDataContext);
  const { run, assets } = getResultState(props.id);
  const kind = ((props.data as ResultNodeData).kind === 'video' ? 'video' : 'image') as 'image' | 'video';
  const running = !!run && (run.status === 'pending' || run.status === 'running');
  const progress = run?.progress;
  const percent = progress?.max ? Math.round((progress.value / progress.max) * 100) : undefined;
  const images = assets.filter((asset) => asset.kind === 'image');
  const videos = assets.filter((asset) => asset.kind === 'video');
  const mediaCount = kind === 'video' ? videos.length : images.length;
  const previewItems = (kind === 'video' ? videos : images) as CanvasMediaItem[];
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  return <div className={`canvas-node canvas-node--result${props.selected ? ' selected' : ''}`}>
    <Handle type="target" position={Position.Left} id={resultTargetHandle(kind)} className={`canvas-handle--${kind}`} title={`${kind === 'video' ? '视频' : '图片'}输入`} />
    <Handle type="source" position={Position.Right} id={resultSourceHandle(kind)} className={`canvas-handle--${kind}`} title={`${kind === 'video' ? '视频' : '图片'}输出`} />
    <div className="canvas-node__header">
      <span className="canvas-node__type" style={{ background: '#722ed1' }}>结果</span>
      <span className="canvas-node__bind" style={{ color: '#999' }}>{running ? (run?.status === 'pending' ? '排队中' : run?.currentNodeTitle || '生成中') : mediaCount ? `${mediaCount} 个${kind === 'video' ? '视频' : '图片'}` : `${kind === 'video' ? '视频' : '图片'}预览`}</span>
      <Popconfirm title="删除该节点？" description="仅移除结果节点和连线，生成资产仍保留在上游节点。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => deleteNode(props.id)}>
        <Button size="small" type="text" danger disabled={readOnly} icon={<DeleteOutlined />} className="nodrag canvas-node__delete-action" aria-label="删除节点" />
      </Popconfirm>
    </div>
    <div className="canvas-node__body canvas-node__result-body nodrag">
      {running ? <div style={{ width: '100%', textAlign: 'center' }}><Spin /><div style={{ margin: '8px 0', color: '#888' }}>{run?.status === 'pending' ? '等待 ComfyUI 执行…' : run?.currentNodeTitle || '正在生成…'}</div><Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /></div>
        : run?.status === 'error' ? <Alert style={{ width: '100%' }} type="error" showIcon message="生成失败" description={run.error || '请检查 ComfyUI 后重试'} />
        : run?.status === 'interrupted' ? <Alert style={{ width: '100%' }} type="warning" showIcon message="运行已中断" />
        : previewItems.length ? <Space direction="vertical" size={8} style={{ width: '100%' }}>{previewItems.map((asset, assetIndex) => <div key={asset.assetId} className="canvas-result-image"><button type="button" className="canvas-media-trigger" onClick={() => setPreviewIndex(assetIndex)} aria-label={`放大预览${asset.kind === 'video' ? '视频' : '图片'}`}>{asset.kind === 'video' ? <><video src={asset.url} muted playsInline preload="metadata" /><PlayCircleFilled className="canvas-media-trigger__play" /></> : <img src={asset.url} alt={asset.filename || '生成图片'} />}</button><Button size="small" icon={<DownloadOutlined />} href={`/api/assets/${asset.assetId}/download`} download={asset.filename || (asset.kind === 'video' ? 'canvas-video.mp4' : 'canvas-image.png')} onClick={(event) => event.stopPropagation()}>下载</Button></div>)}</Space>
        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待上游生成结果" />}
    </div>
    <CanvasMediaPreview open={previewIndex !== null} items={previewItems} index={previewIndex ?? 0} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
  </div>;
}
