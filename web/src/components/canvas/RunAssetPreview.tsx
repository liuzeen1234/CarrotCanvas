import { Button, Image, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { AssetIdLabel } from './nodes/NodeCardFields';

export interface RunOutputAsset { assetId: string; kind: 'image' | 'video' | 'audio'; filename: string | null; mime: string | null; }

/** Display the persisted asset kind; workflow categories do not reliably identify mixed outputs. */
export default function RunAssetPreview({ assetId, asset }: { assetId: string; asset?: RunOutputAsset }) {
  const url = `/api/assets/${assetId}`;
  return <div style={{ width: 260 }}>
    {asset?.kind === 'audio' ? <audio controls preload="metadata" src={url} style={{ width: '100%' }} />
      : asset?.kind === 'video' ? <video controls playsInline preload="metadata" src={url} style={{ width: '100%', borderRadius: 6 }} />
      : asset?.kind === 'image' ? <Image src={url} alt="生成产物" width={112} height={84} style={{ objectFit: 'cover', borderRadius: 6 }} preview={{ mask: '放大预览' }} />
      : <Typography.Text type="secondary">媒体产物（元数据不可用）</Typography.Text>}
    <AssetIdLabel assetId={assetId} />
    <Button size="small" icon={<DownloadOutlined />} href={`${url}/download`} download onClick={(event) => event.stopPropagation()}>下载</Button>
  </div>;
}
