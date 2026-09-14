import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { CloseOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Link, request } from 'umi';

export interface IoItem { itemKey: string; assetId: string; kind: 'text' | 'image' | 'video' | 'audio'; name: string; note: string; text?: string; sourceCanvasId?: string; sourceCanvasName?: string; }
export interface IoSnapshot { id: string; version: number; createdAt: string; sourceOutputsVersion?: number; name?: string; note?: string; items: IoItem[]; }
export interface IoGroup { id: string; name: string; note: string; sourceType: string; sourceCanvasId?: string; sourceCanvasName?: string; activeSnapshotId: string; snapshots: IoSnapshot[]; }
export interface CanvasIo { inputs: IoGroup[]; outputs: IoSnapshot[]; }
export function IoPreview({ item }: { item: IoItem }) {
  const url = `/api/assets/${item.assetId}`;
  return <div style={{ userSelect: 'text' }}>
    {item.kind === 'text' ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }} ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>{item.text}</Typography.Paragraph>
      : item.kind === 'image' ? <img src={url} alt={item.name} loading="lazy" style={{ width: '100%', maxHeight: 180, objectFit: 'contain' }} onClick={() => window.open(url, '_blank')} />
      : item.kind === 'video' ? <video src={url} controls preload="metadata" style={{ width: '100%', maxHeight: 200 }} />
      : <audio src={url} controls preload="metadata" style={{ width: '100%' }} />}
    <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>{item.note}</Typography.Text>
    {item.assetId && <div><a href={`${url}/download`} download={item.name}>下载</a></div>}
  </div>;
}
type Props = { side: 'inputs' | 'outputs'; canvasId: string; io?: CanvasIo | null; writable: boolean; busy: boolean; execute: (command: string, payload?: any, files?: File[]) => Promise<any>; };
export default function CanvasIoPanel({ side, canvasId, io, writable, busy, execute }: Props) {
  const [open, setOpen] = useState(() => window.innerWidth >= 1100 && localStorage.getItem(`canvas-io:${side}`) !== 'false');
  const [sourceOpen, setSourceOpen] = useState(false); const [sources, setSources] = useState<any[]>([]); const [sourceId, setSourceId] = useState<string>(); const [sourceIo, setSourceIo] = useState<CanvasIo>();
  const [publishOpen, setPublishOpen] = useState(false); const [candidates, setCandidates] = useState<any[]>([]); const [selectedKeys, setSelectedKeys] = useState<string[]>([]); const [publishSearch, setPublishSearch] = useState(''); const [publishDrafts, setPublishDrafts] = useState<Record<string, { name: string; note: string }>>({}); const [largePreview, setLargePreview] = useState<any>(); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [replaceKey, setReplaceKey] = useState<string>(); const [update, setUpdate] = useState<any>(); const [editing, setEditing] = useState<any>();
  const run = async (command: string, payload?: any, files?: File[]) => { try { const result = await execute(command, payload, files); message.success(result?.noOp ? '输入已是当前版本' : '已保存'); return result; } catch (error: any) { message.error(error?.response?.data?.message || error.message || '操作失败'); throw error; } };
  useEffect(() => { if (!sourceId) { setSourceIo(undefined); return; } let current = true; setSourceIo(undefined); request<CanvasIo>(`/api/canvas/${sourceId}/io`).then(data => { if (current) setSourceIo(data); }).catch(() => message.error('读取来源失败')); return () => { current = false; }; }, [sourceId]);
  const startCapture = async () => { try { setSources((await request<any[]>('/api/canvas')).filter(c => c.id !== canvasId)); setSourceId(undefined); setSourceOpen(true); } catch { message.error('读取画布列表失败'); } };
  const startPublish = async (key?: string) => {
    try {
      const [doc, history] = await Promise.all([request<any>(`/api/canvas/${canvasId}`), request<any>(`/api/runs?canvasId=${encodeURIComponent(canvasId)}&pageSize=100`)]);
      const choices: any[] = [];
      for (const node of doc.graph.nodes) {
        const label = node.data.cardName || node.data.workflowName || node.id;
        for (const asset of node.data.lastAssets ?? []) choices.push({ key: `node:${node.id}:${asset.assetId}`, label: `${label} · ${asset.filename || asset.kind}`, payload: { nodeId: node.id, assetId: asset.assetId }, item: { ...asset, name: asset.filename || label } });
        if (node.data.lastText) choices.push({ key: `node:${node.id}:text`, label: `${label} · 当前文字`, payload: { nodeId: node.id }, item: { kind: 'text', text: node.data.lastText } });
        for (const part of ['positive','negative']) if (node.data.lastTextParts?.[part]) choices.push({ key: `node:${node.id}:${part}`, label: `${label} · ${part === 'positive' ? '正向' : '负向'}文字`, payload: { nodeId: node.id, textPart: part }, item: { kind: 'text', text: node.data.lastTextParts[part] } });
      }
      for (const record of history.items ?? []) if (record.status === 'succeeded') {
        const label = `${new Date(record.createdAt).toLocaleString()} · 历史`;
        for (const asset of record.outputAssets ?? []) choices.push({ key: `run:${record.id}:${asset.assetId}`, label: `${label} · ${asset.filename || asset.kind}`, payload: { runId: record.id, assetId: asset.assetId }, item: { ...asset, name: asset.filename } });
        if (record.outputText) choices.push({ key: `run:${record.id}:text`, label: `${label} · 文字`, payload: { runId: record.id }, item: { kind: 'text', text: record.outputText } });
      }
      for (const group of io?.inputs ?? []) for (const item of group.snapshots.find(s => s.id === group.activeSnapshotId)?.items ?? []) choices.push({ key: `input:${item.assetId}`, label: `${group.name} · ${item.name}`, payload: { assetId: item.assetId }, item });
      setCandidates(choices); setSelectedKeys([]); setPublishSearch(''); setPublishDrafts(Object.fromEntries(choices.map(c => [c.key, { name: c.item.name || c.label, note: c.item.note || '' }]))); setReplaceKey(key); setPublishOpen(true);
    } catch { message.error('读取产物失败'); }
  };
  const title = side === 'inputs' ? '输入区' : '输出区';
  const toggle = (value: boolean) => { setOpen(value); localStorage.setItem(`canvas-io:${side}`, String(value)); };
  const outputs = io?.outputs?.[io.outputs.length - 1];
  const selected = candidates.filter(c => selectedKeys.includes(c.key));
  const filteredCandidates = candidates.filter(c => c.label.toLowerCase().includes(publishSearch.toLowerCase()));
  const isPublished = (c: any) => !!c.item.assetId && !!outputs?.items.some(item => item.assetId === c.item.assetId && item.itemKey !== replaceKey);
  const duplicateSelection = (c: any) => !!c.item.assetId && selected.some(other => other.key !== c.key && other.item.assetId === c.item.assetId);
  return <>
    <aside style={{ width: open ? 288 : 38, flexShrink: 0, borderRight: '1px solid #eee', borderLeft: '1px solid #eee', background: '#fafafa', minHeight: 0, overflow: 'auto', padding: open ? 12 : 4 }}>
      {!open ? <Button type="text" style={{ writingMode: 'vertical-rl', height: 90 }} onClick={() => toggle(true)}>{title}</Button> : <>
        <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}><Typography.Text strong>{title}</Typography.Text><Button size="small" type="text" icon={<CloseOutlined />} onClick={() => toggle(false)} aria-label={`折叠${title}`} /></Space>
        {side === 'inputs' ? <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Upload multiple accept=".txt,.md,.json,image/png,image/jpeg,image/gif,image/webp,audio/*,video/*" showUploadList={false} disabled={!writable || busy} beforeUpload={(_file, batch) => { if (_file === batch[0]) void run('input.import', {}, batch).catch(() => {}); return false; }}><Button size="small" icon={<UploadOutlined />} disabled={!writable || busy}>本地文件</Button></Upload>
            <Button size="small" icon={<FolderOpenOutlined />} disabled={!writable || busy} onClick={() => void startCapture()}>引入画布</Button>
          </Space>
          {!io?.inputs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="导入文件或其他画布输出" />}
          {io?.inputs.map(group => {
            const active = group.snapshots.find(s => s.id === group.activeSnapshotId)!;
            return <Card key={group.id} size="small" title={<span style={{ whiteSpace: 'normal' }}>{group.name}</span>} style={{ marginBottom: 12 }}>
              {group.sourceCanvasId ? <div><Link to={`/canvas/${group.sourceCanvasId}`}>来源：{group.sourceCanvasName}</Link><div><Typography.Text type="secondary">输出 v{active.sourceOutputsVersion} · {new Date(active.createdAt).toLocaleString()}</Typography.Text></div></div> : <Tag>本地副本</Tag>}
              {group.note && <Typography.Paragraph>{group.note}</Typography.Paragraph>}
              <Space wrap style={{ margin: '8px 0' }}>
                <Button size="small" disabled={!writable || busy} onClick={() => { setName(group.name); setNote(group.note); setEditing({ groupId: group.id }); }}>备注</Button>
                {group.sourceCanvasId && <Button size="small" icon={<ReloadOutlined />} disabled={busy} onClick={async () => { try { const preview = await request<any>(`/api/canvas/${canvasId}/io/inputs/${group.id}/update-preview`); setUpdate({ ...preview, groupId: group.id }); } catch { message.error('检查更新失败'); } }}>检查更新</Button>}
                <Popconfirm title="移除输入组？" description="请先删除对应工作区输入节点；历史生成记录保留。" onConfirm={() => run('input.remove', { groupId: group.id }).catch(() => {})}><Button size="small" danger disabled={!writable || busy}>移除</Button></Popconfirm>
              </Space>
              <Select size="small" style={{ width: '100%', marginBottom: 8 }} value={group.activeSnapshotId} disabled={!writable || busy} options={group.snapshots.map(s => ({ value: s.id, label: `快照 ${s.version} · ${new Date(s.createdAt).toLocaleString()}` }))} onChange={snapshotId => void run('input.restore', { groupId: group.id, snapshotId }).catch(() => {})} />
              {active.items.map(item => <div key={item.itemKey} style={{ borderTop: '1px solid #eee', paddingTop: 8, marginTop: 8 }}><Typography.Text strong>{item.name}</Typography.Text><Tag>{item.kind}</Tag><IoPreview item={item} /><Button size="small" style={{ marginTop: 6 }} disabled={!writable || busy} onClick={() => void run('input.bind', { groupId: group.id, itemKey: item.itemKey, position: { x: 80, y: 80 + active.items.indexOf(item) * 160 } }).catch(() => {})}>加入工作区</Button></div>)}
            </Card>;
          })}
        </> : <>
          <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!writable || busy} onClick={() => void startPublish()}>设为输出</Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>明确发布的成果 · v{outputs?.version ?? 0} · 不随重跑自动变化</Typography.Paragraph>
          {!outputs?.items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从当前或历史产物发布输出" />}
          {outputs?.items.map((item, index) => <Card key={item.itemKey} size="small" title={<span style={{ whiteSpace: 'normal' }}>{item.name}</span>} style={{ marginBottom: 12 }}><IoPreview item={item} /><Space wrap style={{ marginTop: 8 }}>
            <Button size="small" disabled={!writable || busy} onClick={() => { setName(item.name); setNote(item.note); setEditing({ itemKey: item.itemKey }); }}>编辑</Button>
            <Button size="small" disabled={!writable || busy} onClick={() => void startPublish(item.itemKey)}>替换</Button>
            {index > 0 && <Button size="small" disabled={!writable || busy} onClick={() => { const order = outputs.items.map(i => i.itemKey); [order[index-1],order[index]] = [order[index],order[index-1]]; void run('output.reorder', { order }).catch(() => {}); }}>上移</Button>}
            <Popconfirm title="撤下输出？" description="已有下游快照不受影响。" onConfirm={() => run('output.remove', { itemKey: item.itemKey }).catch(() => {})}><Button size="small" danger disabled={!writable || busy}>撤下</Button></Popconfirm>
          </Space></Card>)}
          {io && io.outputs.length > 1 && <details><summary>输出版本记录</summary>{io.outputs.map(s => <div key={s.id} style={{ marginTop: 8 }}>v{s.version} · {new Date(s.createdAt).toLocaleString()}{s.items.map(i => <details key={i.itemKey}><summary>{i.name}</summary><IoPreview item={i} /></details>)}</div>)}</details>}
        </>}
      </>}
    </aside>
    <Modal title="引入画布输出快照" open={sourceOpen} onCancel={() => setSourceOpen(false)} confirmLoading={busy} okButtonProps={{ disabled: !writable || !sourceIo?.outputs.at(-1)?.items.length }} onOk={() => run('input.capture', { sourceCanvasId: sourceId, sourceOutputsVersion: sourceIo?.outputs.at(-1)?.version }).then(() => setSourceOpen(false)).catch(() => {})}>
      <Select showSearch optionFilterProp="label" style={{ width: '100%', marginBottom: 12 }} placeholder="选择任意其他画布" value={sourceId} onChange={setSourceId} options={sources.map(c => ({ value: c.id, label: `${c.name}${c.projects?.length ? ` · ${c.projects.map((p: any) => p.name).join(' / ')}` : ''}` }))} />
      <Alert type="info" message="引入当前全部输出的独立副本，后续仅主动更新才变化。" />
      {sourceIo && !sourceIo.outputs.at(-1)?.items.length && <Empty description="来源尚未发布输出" />}
      {sourceIo?.outputs.at(-1)?.items.map(item => <Card key={item.itemKey} size="small" title={item.name} style={{ marginTop: 8 }}><IoPreview item={item} /></Card>)}
    </Modal>
    <Modal title={replaceKey ? '替换输出内容' : '发布输出'} width={800} open={publishOpen} onCancel={() => { setPublishOpen(false); setLargePreview(undefined); }} confirmLoading={busy} okText={replaceKey ? '替换输出' : `发布所选（${selected.length}）`} okButtonProps={{ disabled: !writable || !selected.length || busy }} onOk={() => {
      const items = selected.map(c => ({ ...c.payload, ...publishDrafts[c.key] }));
      void run(replaceKey ? 'output.replace' : 'output.publish', replaceKey ? { ...items[0], itemKey: replaceKey } : { items }).then(() => setPublishOpen(false)).catch(() => {});
    }}>
      <Typography.Paragraph type="secondary">{replaceKey ? '勾选一个结果替换当前输出。' : '勾选需要发布的结果，预览确认后一次发布为同一输出版本。'}</Typography.Paragraph>
      <Input.Search placeholder="搜索当前内容或历史候选" value={publishSearch} onChange={e => setPublishSearch(e.target.value)} allowClear style={{ marginBottom: 12 }} />
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>已选 {selected.length} 项</Typography.Text>
        {!replaceKey && <Button size="small" disabled={busy || !filteredCandidates.length} onClick={() => {
          const keys = [...selectedKeys]; const assets = new Set(selected.map(c => c.item.assetId).filter(Boolean));
          for (const c of filteredCandidates) { if (keys.length >= 100) break; if (keys.includes(c.key) || isPublished(c) || (c.item.assetId && assets.has(c.item.assetId))) continue; keys.push(c.key); if (c.item.assetId) assets.add(c.item.assetId); }
          setSelectedKeys(keys);
        }}>全选搜索结果</Button>}
        <Button size="small" disabled={busy || !selected.length} onClick={() => setSelectedKeys([])}>清空选择</Button>
      </Space>
      <div style={{ maxHeight: '55vh', overflowY: 'auto', paddingRight: 6 }}>
        {!filteredCandidates.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={candidates.length ? '没有匹配的结果' : '暂无可发布的结果'} />}
        {filteredCandidates.map(c => {
          const checked = selectedKeys.includes(c.key); const draft = publishDrafts[c.key];
          return <Card key={c.key} size="small" style={{ marginBottom: 8, borderColor: checked ? '#1677ff' : undefined }}>
            <Checkbox checked={checked} disabled={busy || isPublished(c) || (!checked && !replaceKey && (selected.length >= 100 || duplicateSelection(c)))} onChange={e => setSelectedKeys(e.target.checked ? (replaceKey ? [c.key] : [...selectedKeys, c.key]) : selectedKeys.filter(key => key !== c.key))}><span style={{ wordBreak: 'break-word' }}>{c.label}</span><Tag style={{ marginLeft: 8 }}>{c.item.kind}</Tag>{isPublished(c) && <Tag>已设为输出</Tag>}</Checkbox>
            {checked && <div style={{ marginTop: 12 }}>
              <IoPreview item={{ ...c.item, name: draft.name }} />
              <Button size="small" style={{ marginTop: 8 }} onClick={() => setLargePreview({ ...c.item, name: draft.name })}>放大预览</Button>
              <Input aria-label={`${c.label}的成果名称`} placeholder="成果名称" value={draft.name} disabled={busy} onChange={e => setPublishDrafts(prev => ({ ...prev, [c.key]: { ...prev[c.key], name: e.target.value } }))} maxLength={200} style={{ marginTop: 12 }} />
              <Input.TextArea aria-label={`${c.label}的说明`} placeholder="说明 / 用途" value={draft.note} disabled={busy} onChange={e => setPublishDrafts(prev => ({ ...prev, [c.key]: { ...prev[c.key], note: e.target.value } }))} maxLength={2000} style={{ marginTop: 8 }} />
            </div>}
          </Card>;
        })}
      </div>
    </Modal>
    <Modal title={largePreview?.name || '结果预览'} width={1000} open={!!largePreview} footer={null} destroyOnClose onCancel={() => setLargePreview(undefined)}>
      {largePreview && <div style={{ maxHeight: '75vh', overflow: 'auto' }}>
        {largePreview.kind === 'text' ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{largePreview.text}</Typography.Paragraph>
          : largePreview.kind === 'image' ? <img src={`/api/assets/${largePreview.assetId}`} alt={largePreview.name} style={{ width: '100%', objectFit: 'contain' }} />
          : largePreview.kind === 'video' ? <video src={`/api/assets/${largePreview.assetId}`} controls style={{ width: '100%', maxHeight: '70vh' }} />
          : <audio src={`/api/assets/${largePreview.assetId}`} controls style={{ width: '100%' }} />}
      </div>}
    </Modal>
    <Modal title="检查输入更新" open={!!update} onCancel={() => setUpdate(undefined)} confirmLoading={busy} okText="更新为新快照" okButtonProps={{ disabled: !writable || !update?.available || !update?.hasUpdate }} onOk={() => run('input.update', { groupId: update.groupId, sourceOutputsVersion: update.sourceOutputsVersion }).then(() => setUpdate(undefined)).catch(() => {})}>
      {!update?.available ? <Alert type="warning" message={update?.message} /> : <><Typography.Paragraph>{update.hasUpdate ? `来源输出 v${update.previousVersion} → v${update.sourceOutputsVersion}` : '已是当前输出版本'}</Typography.Paragraph>{update.changes?.map((c: any, index: number) => <div key={index}><Tag>{c.change}</Tag>{c.name}</div>)}<Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>更新保留旧快照，不自动重跑工作区或改写已有结果。</Typography.Paragraph></>}
    </Modal>
    <Modal title="名称与说明" open={!!editing} onCancel={() => setEditing(undefined)} confirmLoading={busy} onOk={() => run(editing?.groupId ? 'input.edit' : 'output.edit', { ...editing, name, note }).then(() => setEditing(undefined)).catch(() => {})}><Input value={name} onChange={e => setName(e.target.value)} maxLength={200} /><Input.TextArea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} style={{ marginTop: 8 }} /></Modal>
  </>;
}
