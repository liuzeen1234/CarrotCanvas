import { ViewportImage, ViewportVideo, ViewportAudio } from '../ViewportMedia';
import { useContext, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Button, Card, Empty, Modal, Radio, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { UploadOutlined, DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { CanvasNodeDataContext } from '../context';
import { IoPreview, type CanvasIo, type IoItem } from '../CanvasIoPanel';
import { ImeSafeTextArea } from '../ImeSafeInput';
import { AssetIdLabel, NodeCardFields } from './NodeCardFields';
import { CANVAS_NODE_WIDTH } from './types';

/** Literal text or uploaded media sources use the existing typed result contract. */
export default function ReferenceInputNode({ id, data }: NodeProps) {
  const { canvasId, control, readOnly, updateNodeData, deleteNode, newlyAddedNodeIds, bindCanvasOutput } = useContext(CanvasNodeDataContext);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [sources, setSources] = useState<any[]>([]);
  const [sourceId, setSourceId] = useState<string>();
  const [sourceIo, setSourceIo] = useState<CanvasIo>();
  const [sourceItemKey, setSourceItemKey] = useState<string>();
  const kind = String(data.kind ?? 'image');
  const label = ({image:'图片',video:'视频',audio:'音频',text:'文本'} as Record<string,string>)[kind];
  const asset = (data.lastAssets as any[])?.[0];
  const output = sourceIo?.outputs.at(-1);
  const compatibleItems = (output?.items ?? []).filter(item => item.kind === kind);
  useEffect(() => {
    if (!sourceId) { setSourceIo(undefined); setSourceItemKey(undefined); return; }
    let current = true;
    setSourceIo(undefined); setSourceItemKey(undefined);
    request<CanvasIo>(`/api/canvas/${sourceId}/io`)
      .then(io => { if (current) setSourceIo(io); })
      .catch(() => { if (current) message.error('读取来源画布导出区失败'); });
    return () => { current = false; };
  }, [sourceId]);
  const openPicker = async () => {
    setPickerBusy(true);
    try {
      setSources((await request<any[]>('/api/canvas')).filter(canvas => canvas.id !== canvasId));
      setSourceId(undefined); setSourceIo(undefined); setSourceItemKey(undefined); setPickerOpen(true);
    } catch { message.error('读取画布列表失败'); }
    finally { setPickerBusy(false); }
  };
  const chooseOutput = async () => {
    if (!sourceId || !output || !sourceItemKey || !bindCanvasOutput) return;
    setPickerBusy(true);
    try {
      await bindCanvasOutput({ sourceCanvasId: sourceId, sourceOutputsVersion: output.version, sourceItemKey, bindNodeId: id });
      message.success('已从画布导出区复制并绑定资源'); setPickerOpen(false);
    } catch (error: any) { message.error(error?.response?.data?.message || error?.message || '选择资源失败'); }
    finally { setPickerBusy(false); }
  };
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
      {!data.inputGroupId ? <Button style={{ marginTop: 8 }} icon={<FolderOpenOutlined />} loading={pickerBusy} disabled={readOnly || uploading || !bindCanvasOutput} onClick={() => void openPicker()}>从画布导出区选择</Button> : null}
    </div>
    <Modal title={`从画布导出区选择${label}`} width={760} open={pickerOpen} confirmLoading={pickerBusy} okText="复制并使用" okButtonProps={{ disabled: !sourceId || !sourceItemKey || !compatibleItems.length }} onOk={() => void chooseOutput()} onCancel={() => setPickerOpen(false)}>
      <Typography.Paragraph type="secondary">资源会复制到当前画布的输入快照；来源画布后续变化不会自动覆盖。</Typography.Paragraph>
      <Select showSearch optionFilterProp="label" style={{ width: '100%', marginBottom: 12 }} placeholder="选择来源画布" value={sourceId} onChange={setSourceId} options={sources.map(canvas => ({ value: canvas.id, label: `${canvas.name}${canvas.projects?.length ? ` · ${canvas.projects.map((project: any) => project.name).join(' / ')}` : ''}` }))} />
      {sourceIo && !output?.items.length ? <Empty description="这张画布的导出区暂无资源" /> : null}
      {sourceIo && output?.items.length && !compatibleItems.length ? <Empty description={`导出区没有${label}资源`} /> : null}
      {compatibleItems.length ? <Radio.Group value={sourceItemKey} onChange={event => setSourceItemKey(event.target.value)} style={{ width: '100%' }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {compatibleItems.map((item: IoItem) => <Card key={item.itemKey} size="small" style={{ width: '100%', borderColor: sourceItemKey === item.itemKey ? '#1677ff' : undefined }} title={<Radio value={item.itemKey}>{item.name}<Tag style={{ marginLeft: 8 }}>{item.kind}</Tag></Radio>}><IoPreview item={item} /></Card>)}
        </Space>
      </Radio.Group> : null}
    </Modal>
  </div>;
}
