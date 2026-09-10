import { useEffect, useMemo, useState } from 'react';
import { Button, Space, Tag, Typography, message } from 'antd';
import { CheckOutlined, CopyOutlined, DownloadOutlined, PlayCircleFilled, UndoOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { RunDuration } from './RunTiming';
import CanvasMediaPreview, { type CanvasMediaItem } from './CanvasMediaPreview';
import { extractSeedValues } from '@/components/comfyui/types';
import { AssetIdLabel } from './nodes/NodeCardFields';

export interface NodeHistoryRun {
  id: string;
  status: string;
  outputAssetIds: string[];
  outputText: string | null;
  outputParts?: { positive: string; negative: string } | null;
  inputSnapshot?: { carrotOutputMode?: string; carrotPromptIntent?: string } | null;
  createdAt: string;
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  candidateGroup?: { selectedAssetId: string | null; selectedRunId: string | null } | null;
}

export default function NodeOutputHistory({ canvasId, nodeId, kind, promptModeContext, readOnly, refreshKey, control, onSelectAsset, onSelectText, onObserveAsset, onObserveText, onRestoreSeeds }: {
  canvasId?: string; nodeId: string; kind: 'image' | 'video' | 'audio' | 'text'; readOnly: boolean; refreshKey?: unknown;
  promptModeContext?: 'text' | 'image' | 'edit' | 'analyze';
  control?: { leaseToken: string; leaseEpoch: number; expectedRevision: number };
  onSelectAsset?: (asset: { assetId: string; url: string; kind: string }) => void;
  onSelectText?: (text: string, parts?: { positive: string; negative: string } | null) => void;
  onObserveAsset?: (asset: { assetId: string; url: string; kind: string }) => void;
  onObserveText?: (text: string, parts?: { positive: string; negative: string } | null) => void;
  onRestoreSeeds?: (values: Record<string, number>) => void;
}) {
  const [runs, setRuns] = useState<NodeHistoryRun[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const mediaItems = useMemo<CanvasMediaItem[]>(() => kind === 'text' || kind === 'audio' ? [] : runs.flatMap((run) => run.outputAssetIds.map((assetId) => ({ assetId, url: `/api/assets/${assetId}`, kind }))), [kind, runs]);
  const load = async () => {
    if (!canvasId) return;
    try {
      const result = await request<{ items: NodeHistoryRun[] }>(`/api/runs?canvasId=${encodeURIComponent(canvasId)}&nodeId=${encodeURIComponent(nodeId)}&status=succeeded&pageSize=20`);
      const visibleRuns = result.items.filter((run) => run.outputAssetIds.length || run.outputText);
      setRuns(visibleRuns);
      if (readOnly) {
        if (kind === 'text') {
          const selected = visibleRuns.find((run) => run.candidateGroup?.selectedRunId === run.id && run.outputText);
          if (selected?.outputText) onObserveText?.(selected.outputText, selected.outputParts);
        } else {
          const selectedAssetId = visibleRuns.find((run) => run.candidateGroup?.selectedAssetId)?.candidateGroup?.selectedAssetId;
          if (selectedAssetId) onObserveAsset?.({ assetId: selectedAssetId, url: `/api/assets/${selectedAssetId}`, kind });
        }
      }
    }
    catch { /* 历史不可用不影响节点运行 */ }
  };
  useEffect(() => { void load(); }, [canvasId, nodeId, readOnly, refreshKey]);

  const chooseAsset = async (run: NodeHistoryRun, assetId: string) => {
    if (!canvasId || readOnly) return;
    try { await request('/api/runs/candidates/group', { method: 'PATCH', data: { canvasId, nodeId, assetId, actorType: 'human', ...control } }); onSelectAsset?.({ assetId, url: `/api/assets/${assetId}`, kind }); await load(); }
    catch (error: any) { message.error(error?.response?.data?.message || '切换当前输出失败'); }
  };
  const chooseText = async (run: NodeHistoryRun) => {
    if (!canvasId || readOnly || !run.outputText) return;
    try { await request('/api/runs/candidates/text', { method: 'PATCH', data: { canvasId, nodeId, runId: run.id, ...control } }); onSelectText?.(run.outputText, run.outputParts); await load(); }
    catch (error: any) { message.error(error?.response?.data?.message || '切换当前输出失败'); }
  };

  const seedActions = (run: NodeHistoryRun) => {
    const seeds = extractSeedValues(run.inputSnapshot);
    const entries = Object.entries(seeds);
    if (!entries.length) return null;
    const label = entries.map(([key, value]) => `${key.split('::').pop()}=${value}`).join(' · ');
    return <div style={{ marginTop: 4, fontSize: 11, color: '#8c8c8c', wordBreak: 'break-all' }}>
      <span title={entries.map(([key, value]) => `${key}=${value}`).join('\n')}>seed：{label}</span>
      <Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制 seed" onClick={() => void navigator.clipboard.writeText(entries.map(([, value]) => value).join(', ')).then(() => message.success('seed 已复制'))} />
      <Button size="small" type="link" icon={<UndoOutlined />} disabled={readOnly} onClick={() => { onRestoreSeeds?.(seeds); message.success('已恢复该次运行的 seed'); }}>恢复</Button>
    </div>;
  };

  if (!runs.length) return null;
  return <div className="canvas-node-history">
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>生成历史 · {runs.reduce((sum, run) => sum + Math.max(1, run.outputAssetIds.length), 0)}</Typography.Text>
    <div className="canvas-node-history__rail">
      {runs.flatMap((run) => kind === 'text' ? [<button type="button" key={run.id} disabled={readOnly} className={`canvas-node-history__text${run.candidateGroup?.selectedRunId === run.id ? ' is-current' : ''}`} onClick={() => void chooseText(run)}>{promptModeLabel(run, promptModeContext) ? <span className={`canvas-node-history__mode ${promptModeLabel(run, promptModeContext) === '视频提示词' ? 'is-video' : ''}`}>{promptModeLabel(run, promptModeContext)}</span> : null}<span className="canvas-node-history__text-summary">{textSummary(run.outputText || '')}</span><RunDuration timestamps={run} />{seedActions(run)}{run.candidateGroup?.selectedRunId === run.id ? <span className="canvas-node-history__current" title="当前版本" aria-label="当前版本"><CheckOutlined /></span> : null}</button>] : run.outputAssetIds.map((assetId) => {
        const current = run.candidateGroup?.selectedAssetId === assetId;
        return <div key={assetId} className={`canvas-node-history__media${current ? ' is-current' : ''}`}>
          {kind === 'audio' ? <audio controls src={`/api/assets/${assetId}`} style={{ width: '100%' }} /> : <button type="button" className="canvas-media-trigger canvas-media-trigger--history" onClick={() => setPreviewIndex(mediaItems.findIndex((item) => item.assetId === assetId))} aria-label={`放大预览${kind === 'video' ? '视频' : '图片'}`}>{kind === 'video' ? <><video src={`/api/assets/${assetId}`} muted playsInline preload="metadata" /><PlayCircleFilled className="canvas-media-trigger__play" /></> : <img src={`/api/assets/${assetId}`} alt="历史图片产物" />}</button>}
          <AssetIdLabel assetId={assetId} />
          <RunDuration timestamps={run} />
          {seedActions(run)}
          <Space size={2}>{current ? <Tag color="blue" icon={<CheckOutlined />}>当前</Tag> : <Button size="small" disabled={readOnly} onClick={() => void chooseAsset(run, assetId)}>使用</Button>}<Button size="small" type="text" icon={<DownloadOutlined />} href={`/api/assets/${assetId}/download`} download aria-label="下载历史产物" /></Space>
        </div>;
      }))}
    </div>
    <CanvasMediaPreview open={previewIndex !== null} items={mediaItems} index={previewIndex ?? 0} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
  </div>;
}

function textSummary(text: string) { const compact = text.replace(/\s+/g, ' ').trim(); return compact.length > 90 ? `${compact.slice(0, 90)}…` : compact; }
function promptModeLabel(run: NodeHistoryRun, context?: 'text' | 'image' | 'edit' | 'analyze') {
  const mode = run.inputSnapshot?.carrotOutputMode;
  if (mode === 'video-prompts') return '视频提示词';
  if (run.inputSnapshot?.carrotPromptIntent === 'reverse-image-prompt' || (mode === 'image-prompts' && context === 'analyze')) return '提示词反推';
  return mode === 'image-prompts' ? '图像提示词' : '';
}
