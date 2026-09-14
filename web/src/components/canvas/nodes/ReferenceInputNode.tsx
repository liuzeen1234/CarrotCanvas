import { ViewportImage, ViewportVideo, ViewportAudio } from '../ViewportMedia';
import { useContext, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Button, Upload, message } from 'antd';
import { UploadOutlined, DeleteOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { CanvasNodeDataContext } from '../context';
import { ImeSafeTextArea } from '../ImeSafeInput';
import { AssetIdLabel, NodeCardFields } from './NodeCardFields';
import { CANVAS_NODE_WIDTH } from './types';

/** Literal text or uploaded media sources use the existing typed result contract. */
export default function ReferenceInputNode({ id, data }: NodeProps) {
  const { canvasId, control, readOnly, updateNodeData, deleteNode, newlyAddedNodeIds } = useContext(CanvasNodeDataContext);
  const [uploading, setUploading] = useState(false);
  const kind = String(data.kind ?? 'image');
  const label = ({image:'图片',video:'视频',audio:'音频',text:'文本'} as Record<string,string>)[kind];
  const asset = (data.lastAssets as any[])?.[0];
  return <div className={`canvas-node canvas-node--result${newlyAddedNodeIds?.includes(id) ? ' canvas-node--input-highlight' : ''}`} style={{ width: CANVAS_NODE_WIDTH, maxWidth: '100%', boxSizing: 'border-box' }}>
    <Handle type="source" position={Position.Right} id={`${kind}-source`} className={`canvas-handle--${kind}`} title={`${label}输出`} />
    <div className="canvas-node__header"><span className="canvas-node__bind" title={String(data.cardName || `${label}输入`)}>{String(data.cardName || `${label}输入`)}</span><Button type="text" size="small" disabled={readOnly} icon={<DeleteOutlined />} onClick={() => deleteNode(id)} aria-label="删除输入节点" /></div>
    <div className="canvas-node__body nodrag">
      <NodeCardFields name={String(data.cardName ?? '')} note={String(data.note ?? '')} readOnly={readOnly} onChange={(patch) => updateNodeData(id, patch)} />
      {data.inputGroupId ? <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>{data.inputDetachedReason === 'group_removed' ? '输入已移除 · 当前使用保留副本' : data.inputDetachedReason === 'removed' ? '新版输入已移除 · 当前使用旧快照' : data.inputDetachedReason === 'kind_changed' ? '新版输入类型已变化 · 当前使用旧快照' : '输入快照 · 在输入区更新内容'}</div> : null}
      {kind === 'text' ? <ImeSafeTextArea value={String(data.lastText ?? '')} disabled={readOnly || !!data.inputGroupId} onChange={lastText => updateNodeData(id,{lastText})} autoSize={{minRows:3}} placeholder="提示词、数字、true / false 或下拉选项值" /> : <>
        {asset ? kind === 'video' ? <ViewportVideo src={asset.url} controls style={{width:'100%'}} /> : kind === 'audio' ? <ViewportAudio src={asset.url} controls style={{width:'100%'}} /> : <ViewportImage loading="lazy" decoding="async" src={asset.url} alt={asset.filename} style={{ display: 'block', width: 'auto', maxWidth: '100%', height: 'auto' }} /> : null}
        {asset?.filename ? <div className="canvas-reference-input__filename" title={asset.filename}>{asset.filename}</div> : null}
        <AssetIdLabel assetId={asset?.assetId} />
        <Upload accept={`${kind}/*`} showUploadList={false} disabled={readOnly || uploading || !!data.inputGroupId} customRequest={async ({file,onSuccess,onError}) => {
          setUploading(true);
          try {
            if (!canvasId || !control || readOnly) throw new Error('请先取得画布编辑权');
            const form = new FormData(); form.append('file',file as File); form.append('kind',kind); form.append('canvasId',canvasId); form.append('nodeId',id);
            for (const [key,value] of Object.entries(control)) if (value != null) form.append(key,String(value));
            const result = await request<{asset:unknown}>('/api/comfyui/upload/media',{method:'POST',data:form,requestType:'form'});
            updateNodeData(id,{lastAssets:[result.asset]}); onSuccess?.({});
          } catch(error:any) { message.error(error?.response?.data?.message || '上传失败'); onError?.(error); }
          finally { setUploading(false); }
        }}><Button icon={<UploadOutlined />} loading={uploading} disabled={readOnly || !!data.inputGroupId}>上传{label}</Button></Upload>
      </>}
    </div>
  </div>;
}
