import { useEffect, useState } from 'react';
import { Button, Card, Empty, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { history, request } from 'umi';
export default function ProjectsPage() {
  const [items,setItems] = useState<any[]>([]); const [loading,setLoading] = useState(true); const [open,setOpen] = useState(false); const [name,setName] = useState(''); const [description,setDescription] = useState(''); const [busy,setBusy] = useState(false);
  useEffect(() => { request<any[]>('/api/projects').then(setItems).catch(() => message.error('读取项目失败')).finally(() => setLoading(false)); }, []);
  return <div style={{ padding: 24 }}><Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 20 }}><div><Typography.Title level={3} style={{ margin: 0 }}>项目</Typography.Title><Typography.Text type="secondary">组织画布 · 保存最终成果快照</Typography.Text></div><Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建项目</Button></Space>
    <Spin spinning={loading}>{!loading && !items.length ? <Empty description="创建项目，把相关画布组织起来" /> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>{items.map(item => <Card key={item.id} hoverable title={item.name} onClick={() => history.push(`/projects/${item.id}`)}><Typography.Paragraph ellipsis={{ rows: 2 }}>{item.description}</Typography.Paragraph><Tag color="blue">{item.canvasCount} 张画布</Tag><Tag color="green">{item.resultCount} 项成果</Tag><Tag>成果副本 {(item.assetSize / 1024 / 1024).toFixed(1)} MB</Tag><div style={{ color: '#999', marginTop: 12 }}>更新于 {new Date(item.updatedAt).toLocaleString()}</div></Card>)}</div>}</Spin>
    <Modal title="新建项目" open={open} onCancel={() => setOpen(false)} confirmLoading={busy} onOk={async () => { setBusy(true); try { const project = await request<any>('/api/projects', { method: 'POST', data: { name: name.trim() || '新项目', description } }); history.push(`/projects/${project.id}`); } catch { message.error('创建项目失败'); } finally { setBusy(false); } }}><Input placeholder="项目名称" value={name} onChange={e => setName(e.target.value)} maxLength={200} /><Input.TextArea placeholder="项目说明" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} style={{ marginTop: 12 }} /></Modal>
  </div>;
}
