import { Button, Tooltip, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { ImeSafeInput, ImeSafeTextArea } from '../ImeSafeInput';

export function NodeCardFields({ name, note, readOnly, onChange }: {
  name?: string;
  note?: string;
  readOnly: boolean;
  onChange: (patch: { cardName?: string; note?: string }) => void;
}) {
  return <div className="canvas-node-card-fields">
    <ImeSafeInput value={name || ''} disabled={readOnly} onChange={(cardName) => onChange({ cardName })} placeholder="卡片名称（可选）" />
    <ImeSafeTextArea value={note || ''} disabled={readOnly} onChange={(nextNote) => onChange({ note: nextNote })} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="卡片备注（可选）" />
  </div>;
}

export function AssetIdLabel({ assetId }: { assetId?: string | null }) {
  if (!assetId) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(assetId);
      message.success('assetId 已复制');
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  };
  return <div className="canvas-asset-id" title={assetId}>
    <span className="canvas-asset-id__label">assetId</span>
    <code className="canvas-asset-id__value">{assetId}</code>
    <Tooltip title="复制 assetId"><Button size="small" type="text" icon={<CopyOutlined />} onClick={(event) => { event.stopPropagation(); void copy(); }} aria-label="复制 assetId" /></Tooltip>
  </div>;
}
