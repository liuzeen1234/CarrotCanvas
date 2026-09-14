import { useContext, useState } from 'react';
import { Button, Modal, Select, Typography, message } from 'antd';
import { CanvasNodeDataContext } from './context';
import { IoPreview } from './CanvasIoPanel';

/** Explicitly publish one current candidate from the generating card. */
export default function CardOutputButton({ nodeId, name, assets, text, parts, disabled }: {
  nodeId: string; name: string; assets: Array<{ assetId: string; kind: string; filename?: string }>;
  text?: string; parts?: { positive?: string; negative?: string }; disabled?: boolean;
}) {
  const { readOnly, publishOutput, publishedOutputs = [] } = useContext(CanvasNodeDataContext);
  const [open, setOpen] = useState(false); const [key, setKey] = useState(''); const [saving, setSaving] = useState(false);
  const options = assets.filter(a => a.assetId).map(a => ({ key: a.assetId, slot: `${nodeId}:${a.kind}`, payload: { nodeId, assetId: a.assetId, name }, item: { ...a, name } }));
  for (const part of ['combined', 'positive', 'negative'] as const) {
    const value = part === 'combined' ? text : parts?.[part];
    if (value) options.push({ key: part, slot: `${nodeId}:text:${part}`, payload: { nodeId, name: part === 'combined' ? name : `${name} · ${part === 'positive' ? '正向' : '负向'}`, ...(part === 'combined' ? {} : { textPart: part }) }, item: { kind: 'text', text: value, name } } as any);
  }
  if (!options.length || !publishOutput) return null;
  const selected = options.find(o => o.key === key) || options[0];
  const state = (option: typeof selected) => {
    const previous = publishedOutputs.find(o => (o.outputSlot || (o.sourceNodeId ? `${o.sourceNodeId}:${o.kind}${o.kind === 'text' ? ':combined' : ''}` : '')) === option.slot);
    const same = !!previous && ((option.item as any).assetId ? previous.assetId === (option.item as any).assetId : previous.text === (option.item as any).text);
    return same ? '已设为输出' : previous ? '更新输出' : '设为输出';
  };
  const allPublished = options.every(o => state(o) === '已设为输出');
  const label = allPublished ? '已设为输出' : options.some(o => state(o) !== '设为输出') ? '更新输出' : '设为输出';
  const publish = async () => {
    setSaving(true);
    try { await publishOutput(selected.payload); message.success('已发布画布输出'); setOpen(false); }
    catch (error: any) { message.error(error?.response?.data?.message || error.message || '发布失败'); }
    finally { setSaving(false); }
  };
  return <div className="nodrag nopan" style={{ margin: '8px 0' }} onClick={e => e.stopPropagation()}>
    <Button size="small" disabled={readOnly || disabled || saving || allPublished} loading={saving} onClick={() => options.length === 1 ? void publish() : (setKey(options[0].key), setOpen(true))}>{label}</Button>
    <Modal title="发布卡片输出" open={open} onCancel={() => setOpen(false)} confirmLoading={saving} okText={state(selected)} okButtonProps={{ disabled: readOnly || disabled || state(selected) === '已设为输出' }} onOk={() => void publish()}>
      <Typography.Paragraph type="secondary">选择当前产物或文字端口。发布会替换对应输出；下游已有快照保持不变。</Typography.Paragraph>
      <Select style={{ width: '100%', marginBottom: 12 }} value={selected.key} onChange={setKey} options={options.map(o => ({ value: o.key, label: `${o.key === 'combined' ? '完整文字' : o.key === 'positive' ? '正向文字' : o.key === 'negative' ? '负向文字' : o.item.filename || o.item.kind} · ${state(o)}` }))} />
      <IoPreview item={selected.item as any} />
    </Modal>
  </div>;
}
