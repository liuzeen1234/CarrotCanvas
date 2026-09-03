/** C6 结果节点：通过连线读取上游运行态与平台资产，不冗余持久化引用。 */
import { useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Alert, Button, Empty, Image, Popconfirm, Progress, Space, Spin, Tooltip } from 'antd';
import { DeleteOutlined, DownloadOutlined } from '@ant-design/icons';
import { CanvasNodeDataContext } from '../context';
import { ResultNodeData, resultSourceHandle, resultTargetHandle } from './types';

export default function ResultNode(props: NodeProps) {
  const { deleteNode, getResultState } = useContext(CanvasNodeDataContext);
  const { run, assets } = getResultState(props.id);
  const kind = ((props.data as ResultNodeData).kind === 'video' ? 'video' : 'image') as 'image' | 'video';
  const running = !!run && (run.status === 'pending' || run.status === 'running');
  const progress = run?.progress;
  const percent = progress?.max ? Math.round((progress.value / progress.max) * 100) : undefined;
  const images = assets.filter((asset) => asset.kind === 'image');
  const videos = assets.filter((asset) => asset.kind === 'video');
  const mediaCount = kind === 'video' ? videos.length : images.length;

  return <div className={`canvas-node canvas-node--result${props.selected ? ' selected' : ''}`}>
    <Handle type="target" position={Position.Left} id={resultTargetHandle(kind)} className={`canvas-handle--${kind}`} title={`${kind === 'video' ? '视频' : '图片'}输入`} />
    <Handle type="source" position={Position.Right} id={resultSourceHandle(kind)} className={`canvas-handle--${kind}`} title={`${kind === 'video' ? '视频' : '图片'}输出`} />
    <div className="canvas-node__header">
      <span className="canvas-node__type" style={{ background: '#722ed1' }}>结果</span>
      <span className="canvas-node__bind" style={{ color: '#999' }}>{running ? (run?.status === 'pending' ? '排队中' : run?.currentNodeTitle || '生成中') : mediaCount ? `${mediaCount} 个${kind === 'video' ? '视频' : '图片'}` : `${kind === 'video' ? '视频' : '图片'}预览`}</span>
      <Popconfirm title="删除该节点？" description="仅移除结果节点和连线，生成资产仍保留在上游节点。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => deleteNode(props.id)}>
        <Tooltip title="删除节点"><Button size="small" type="text" danger icon={<DeleteOutlined />} className="nodrag" /></Tooltip>
      </Popconfirm>
    </div>
    <div className="canvas-node__body canvas-node__result-body nodrag">
      {running ? <div style={{ width: '100%', textAlign: 'center' }}><Spin /><div style={{ margin: '8px 0', color: '#888' }}>{run?.status === 'pending' ? '等待 ComfyUI 执行…' : run?.currentNodeTitle || '正在生成…'}</div><Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /></div>
        : run?.status === 'error' ? <Alert style={{ width: '100%' }} type="error" showIcon message="生成失败" description={run.error || '请检查 ComfyUI 后重试'} />
        : run?.status === 'interrupted' ? <Alert style={{ width: '100%' }} type="warning" showIcon message="运行已中断" />
        : kind === 'video' && videos.length ? <Space direction="vertical" size={8} style={{ width: '100%' }}>{videos.map((asset) => <div key={asset.assetId} className="canvas-result-image"><video src={asset.url} controls playsInline preload="metadata" style={{ width: '100%', display: 'block', marginBottom: 6 }} /><Button size="small" icon={<DownloadOutlined />} href={`/api/assets/${asset.assetId}/download`}>下载</Button></div>)}</Space>
        : images.length ? <Image.PreviewGroup><Space direction="vertical" size={8} style={{ width: '100%' }}>{images.map((asset) => <div key={asset.assetId} className="canvas-result-image"><Image src={asset.url} alt={asset.filename || '生成图片'} width="100%" /><Button size="small" icon={<DownloadOutlined />} href={`/api/assets/${asset.assetId}/download`}>下载</Button></div>)}</Space></Image.PreviewGroup>
        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待上游生成结果" />}
    </div>
  </div>;
}
