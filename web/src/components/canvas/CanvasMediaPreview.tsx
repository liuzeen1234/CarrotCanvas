import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Segmented, Space, Typography } from 'antd';
import { DownloadOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import './CanvasMediaPreview.css';

export interface CanvasMediaItem {
  assetId: string;
  url: string;
  kind: 'image' | 'video';
  filename?: string;
}

export default function CanvasMediaPreview({ open, items, index, onIndexChange, onClose }: {
  open: boolean;
  items: CanvasMediaItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [videoMode, setVideoMode] = useState<'actual' | 'fit'>('actual');
  const downloadName = useMemo(() => item?.filename || (item?.kind === 'video' ? 'canvas-video.mp4' : 'canvas-image.png'), [item]);

  useEffect(() => {
    setVideoSize(null);
    setVideoMode('actual');
    return () => { videoRef.current?.pause(); };
  }, [open, index]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onIndexChange(index - 1); }
      if (event.key === 'ArrowRight' && index < items.length - 1) { event.preventDefault(); onIndexChange(index + 1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, items.length, onIndexChange, open]);

  const close = () => { videoRef.current?.pause(); onClose(); };
  const move = (nextIndex: number) => { videoRef.current?.pause(); onIndexChange(nextIndex); };

  return <Modal
    className="canvas-media-preview"
    open={open && !!item}
    onCancel={close}
    footer={null}
    centered
    width="calc(100vw - 48px)"
    destroyOnClose
    title={item ? `${item.kind === 'video' ? '视频' : '图片'}预览` : '媒体预览'}
    styles={{ body: { padding: 0 } }}
  >
    {item ? <>
      <div className="canvas-media-preview__toolbar">
        <Space size="small">
          <Button icon={<LeftOutlined />} disabled={index === 0} onClick={() => move(index - 1)} aria-label="上一项">上一项</Button>
          <Typography.Text>{index + 1} / {items.length}</Typography.Text>
          <Button icon={<RightOutlined />} disabled={index === items.length - 1} onClick={() => move(index + 1)} aria-label="下一项">下一项</Button>
        </Space>
        <Space size="small">
          {item.kind === 'video' ? <>
            {videoSize ? <Typography.Text type="secondary">{videoSize.width} × {videoSize.height}</Typography.Text> : null}
            <Segmented
              value={videoMode}
              options={[{ label: '100%', value: 'actual' }, { label: '适应窗口', value: 'fit' }]}
              onChange={(value) => setVideoMode(value as 'actual' | 'fit')}
            />
          </> : null}
          <Button icon={<DownloadOutlined />} href={item.assetId ? `/api/assets/${item.assetId}/download` : item.url} download={downloadName}>下载当前产物</Button>
        </Space>
      </div>
      <div className={`canvas-media-preview__stage${item.kind === 'video' && videoMode === 'actual' ? ' is-actual' : ' is-fit'}`}>
        {item.kind === 'video'
          ? <video
              key={item.assetId}
              ref={videoRef}
              src={item.url}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
              style={videoMode === 'actual' && videoSize ? { width: videoSize.width, height: videoSize.height } : undefined}
            />
          : <img key={item.assetId} src={item.url} alt={item.filename || '生成图片'} />}
      </div>
    </> : null}
  </Modal>;
}
