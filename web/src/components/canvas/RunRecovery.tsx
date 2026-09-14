import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { request } from 'umi';

export interface RecoveryMetadata {
  sourceRunId: string; sourceStatus: string; reason: string; evidence: string; recoveredAt: number;
}
export interface RecoverableRun { id: string; status: string; createdAt?: string; recovery?: RecoveryMetadata | null; }
export const isRecoverableRun = (run: RecoverableRun) => !run.recovery && ['failed', 'cancelled', 'needs_attention'].includes(run.status);

export function RecoveryLabel({ recovery }: { recovery?: RecoveryMetadata | null }) {
  if (!recovery) return null;
  return <Tag color="purple" title={`原 Run：${recovery.sourceRunId}\n原状态：${recovery.sourceStatus}\n原因：${recovery.reason}\n来源与关联依据：${recovery.evidence}`}>补录恢复</Tag>;
}

/** Shared UI for node history and canvas timeline. Never invokes a generation provider. */
export default function RunRecovery({ runs, currentAssetId, readOnly, control, onRecovered }: {
  runs: RecoverableRun[]; currentAssetId?: string; readOnly: boolean;
  control?: { leaseToken: string; leaseEpoch: number; expectedRevision: number };
  onRecovered: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [hint, setHint] = useState('');
  const [form] = Form.useForm();
  const sourceRunId = Form.useWatch('sourceRunId', form);
  const assetId = Form.useWatch('assetId', form);
  const sources = runs.filter(isRecoverableRun);
  useEffect(() => {
    if (!open || !sourceRunId) return;
    let cancelled = false;
    setDiscovering(true);
    const timer = window.setTimeout(() => {
      void request<{ assetId: string; reason: string; evidence: string; hint: string }>(`/api/runs/${encodeURIComponent(sourceRunId)}/recovery-suggestion`, { params: { assetId: assetId?.trim() || undefined } }).then((result) => {
        if (cancelled) return;
        const fields = ['reason', 'evidence'].filter((name) => !form.isFieldTouched(name)).map((name) => ({ name, value: result[name as 'reason' | 'evidence'], touched: false }));
        if (!form.getFieldValue('assetId') && result.assetId) fields.push({ name: 'assetId', value: result.assetId, touched: false });
        form.setFields(fields);
        setHint(result.hint);
      }).catch((error: any) => {
        if (!cancelled) setHint(error?.response?.data?.message || error?.data?.message || '自动查找暂不可用，请手动补充说明，或关闭后重试。');
      }).finally(() => { if (!cancelled) setDiscovering(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, sourceRunId, assetId, form]);
  if (!sources.length) return null;
  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values || !control || readOnly || saving || discovering) return;
    setSaving(true);
    try {
      const result = await request<{ replay: boolean }>(`/api/runs/${encodeURIComponent(values.sourceRunId)}/recover`, {
        method: 'POST', data: { ...control, assetId: values.assetId.trim(), reason: values.reason.trim(), evidence: values.evidence.trim() },
      });
      message.success(result.replay ? '该图片已补录，没有重复创建历史' : '产物已补入恢复历史，原失败记录保留');
      setOpen(false);
      await onRecovered();
    } catch (error: any) { message.error(error?.response?.data?.message || error?.data?.message || '补录失败，请核对资产归属与编辑权'); }
    finally { setSaving(false); }
  };
  return <>
    <Button size="small" disabled={readOnly || !control} onClick={() => {
      form.resetFields();
      form.setFields([{ name: 'sourceRunId', value: sources[0].id, touched: false }, { name: 'assetId', value: currentAssetId || '', touched: false }, { name: 'reason', value: '', touched: false }, { name: 'evidence', value: '', touched: false }]);
      setHint('');
      setOpen(true);
    }}>补录恢复</Button>
    <Modal title="补录已有产物到生成历史" open={open} confirmLoading={saving} okText="确认补录" cancelText="取消" onOk={() => void submit()} onCancel={() => { if (!saving) setOpen(false); }} okButtonProps={{ disabled: readOnly || !control || discovering }}>
      <Alert type="info" showIcon message="不重新生成，不改写原失败记录，也不替换当前产物。" description="系统优先查找原请求、当前产物及节点备注，自动填入可查证的关联说明；没有足够记录时才需要你补充。节点备注不代表上游任务已核验，请核对后确认。" style={{ marginBottom: 16 }} />
      <Typography.Paragraph type="secondary">{discovering ? '正在自动查找补录原因与来源依据…' : hint}</Typography.Paragraph>
      <Form form={form} layout="vertical" onValuesChange={(changed) => {
        if ('sourceRunId' in changed || 'assetId' in changed) {
          form.setFields([{ name: 'reason', value: '', touched: false, errors: [] }, { name: 'evidence', value: '', touched: false, errors: [] }]);
          setDiscovering(true);
        }
      }}>
        <Form.Item name="sourceRunId" label="原请求 Run" rules={[{ required: true }]}><Select options={sources.map((run) => ({ value: run.id, label: `${run.status} · ${run.id}` }))} /></Form.Item>
        <Form.Item name="assetId" label="已有产物 assetId" rules={[{ required: true, whitespace: true, max: 100 }]}><Input placeholder="粘贴本画布、原节点的产物 ID" /></Form.Item>
        <Form.Item name="reason" label="补录原因" rules={[{ required: true, whitespace: true, max: 2000 }]}><Input.TextArea rows={2} maxLength={2000} placeholder="例如：原请求超时，但上游任务随后完成" /></Form.Item>
        <Form.Item name="evidence" label="来源与关联依据" rules={[{ required: true, whitespace: true, max: 4000 }]}><Input.TextArea rows={3} maxLength={4000} placeholder="例如：提供方任务 ID、输出文件名或找回经过，说明为何属于原请求" /></Form.Item>
      </Form>
    </Modal>
  </>;
}

export function RecoveryDetails({ recovery, actor }: { recovery?: RecoveryMetadata | null; actor?: string }) {
  if (!recovery) return null;
  return <Space direction="vertical" size={2} style={{ marginTop: 6, width: '100%' }}>
    <Typography.Text copyable={{ text: recovery.sourceRunId }}>原 Run：{recovery.sourceRunId}（{recovery.sourceStatus}）</Typography.Text>
    <Typography.Text>补录原因：{recovery.reason}</Typography.Text>
    <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 2, expandable: true, symbol: '展开来源说明' }}>来源与关联依据：{recovery.evidence}</Typography.Paragraph>
    <Typography.Text type="secondary">补录时间：{new Date(recovery.recoveredAt).toLocaleString()}{actor ? ` · 操作者：${actor}` : ''} · 无新生成请求</Typography.Text>
  </Space>;
}
