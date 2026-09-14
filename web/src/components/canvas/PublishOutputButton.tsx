import { useContext, useState } from 'react';
import { Button, message } from 'antd';
import { CanvasNodeDataContext } from './context';

/** Publish the specific visible item without switching the node's selected candidate. */
export default function PublishOutputButton({ payload, label = '设为输出', disabled = false }: { payload: Record<string, unknown>; label?: string; disabled?: boolean }) {
  const { readOnly, publishOutput, publishedAssetIds } = useContext(CanvasNodeDataContext);
  const published = typeof payload.assetId === 'string' && publishedAssetIds?.includes(payload.assetId);
  const [saving, setSaving] = useState(false);
  if (!publishOutput) return null;
  return <Button size="small" className="nodrag nopan" disabled={readOnly || disabled || saving || published} loading={saving} onClick={async event => {
    event.stopPropagation(); setSaving(true);
    try { await publishOutput(payload); message.success('已设为画布输出'); }
    catch (error: any) { message.error(error?.response?.data?.message || error.message || '发布输出失败'); }
    finally { setSaving(false); }
  }}>{published ? '已设为输出' : label}</Button>;
}
