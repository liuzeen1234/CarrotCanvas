import { ViewportImage, ViewportVideo, ViewportAudio } from './ViewportMedia';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Space, Tag, Typography, message } from 'antd';
import { CheckOutlined, CopyOutlined, DownloadOutlined, PlayCircleFilled, UndoOutlined } from '@ant-design/icons';
import { request } from 'umi';
import { RunDuration } from './RunTiming';
import CanvasMediaPreview, { type CanvasMediaItem } from './CanvasMediaPreview';
import { extractSeedValues } from '@/components/comfyui/types';
import { AssetIdLabel } from './nodes/NodeCardFields';
import RunRecovery, { RecoveryLabel, type RecoveryMetadata } from './RunRecovery';

export interface NodeHistoryRun {
  id: string;
  status: string;
  recovery?: RecoveryMetadata | null;
  outputAssetIds: string[];
  outputAssets?: Array<{ assetId: string; kind: string; filename?: string; mime?: string }>;
  outputText: string | null;
  outputParts?: { positive: string; negative: string } | null;
  inputSnapshot?: { carrotOutputMode?: string; carrotPromptIntent?: string } | null;
  createdAt: string;
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  candidateGroup?: { selectedAssetId: string | null; selectedRunId: string | null; selectedByKind?: Partial<Record<'image' | 'video' | 'audio', string>> | null } | null;
}

export default function NodeOutputHistory({ canvasId, nodeId, cardName, kind, promptModeContext, readOnly, refreshKey, control, currentAssetId, onSelectAsset, onSelectText, onObserveAsset, onObserveText, onRestoreSeeds }: {
  canvasId?: string; nodeId: string; cardName?: string; kind: 'image' | 'video' | 'audio' | 'text'; readOnly: boolean; refreshKey?: unknown;
  promptModeContext?: 'text' | 'image' | 'edit' | 'analyze';
  control?: { leaseToken: string; leaseEpoch: number; expectedRevision: number };
  currentAssetId?: string;
  onSelectAsset?: (asset: { assetId: string; url: string; kind: string }) => void;
  onSelectText?: (text: string, parts?: { positive: string; negative: string } | null) => void;
  onObserveAsset?: (asset: { assetId: string; url: string; kind: string }) => void;
  onObserveText?: (text: string, parts?: { positive: string; negative: string } | null) => void;
  onRestoreSeeds?: (values: Record<string, number>) => void;
}) {
  const [runs, setRuns] = useState<NodeHistoryRun[]>([]);
  const [sourceRuns, setSourceRuns] = useState<NodeHistoryRun[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const assetIdsForKind = useCallback((run: NodeHistoryRun) => run.outputAssets?.length
    ? run.outputAssets.filter((asset) => asset.kind === kind).map((asset) => asset.assetId)
    : run.outputAssetIds, [kind]);
  // 本轨道（当前 kind）应选中的资产：优先 selectedByKind[kind]；
  // 缺失时才回退到旧的单选字段，且仅当它确实属于本 kind（避免视频轨道错认音频的 selectedAssetId）。
  const selectedAssetIdForKind = useCallback((run: NodeHistoryRun) => {
    const group = run.candidateGroup;
    if (!group) return null;
    const byKind = group.selectedByKind?.[kind as 'image' | 'video' | 'audio'];
    if (byKind) return byKind;
    if (group.selectedAssetId && assetIdsForKind(run).includes(group.selectedAssetId)) return group.selectedAssetId;
    return null;
  }, [assetIdsForKind, kind]);
  const mediaItems = useMemo<CanvasMediaItem[]>(() => kind === 'text' || kind === 'audio' ? [] : runs.flatMap((run) => assetIdsForKind(run).map((assetId) => ({ assetId, url: `/api/assets/${assetId}`, kind }))), [assetIdsForKind, kind, runs]);
  const load = async () => {
    if (!canvasId) return;
    try {
      const result = await request<{ items: NodeHistoryRun[]; recoverableRuns?: NodeHistoryRun[] }>(`/api/runs?canvasId=${encodeURIComponent(canvasId)}&nodeId=${encodeURIComponent(nodeId)}&status=succeeded&pageSize=20${kind === 'text' ? '' : '&includeRecoverable=true'}`);
      setSourceRuns(result.recoverableRuns || []);
      const visibleRuns = result.items.filter((run) => assetIdsForKind(run).length || run.outputText);
      setRuns(visibleRuns);
      if (readOnly) {
        if (kind === 'text') {
          const selected = visibleRuns.find((run) => run.candidateGroup?.selectedRunId === run.id && run.outputText);
          if (selected?.outputText) onObserveText?.(selected.outputText, selected.outputParts);
        } else {
          const selectedAssetId = visibleRuns.map((run) => selectedAssetIdForKind(run)).find((assetId) => !!assetId);
          if (selectedAssetId) onObserveAsset?.({ assetId: selectedAssetId, url: `/api/assets/${selectedAssetId}`, kind });
        }
      }
    }
    catch { /* 历史不可用不影响节点运行 */ }
  };
  useEffect(() => { void load(); }, [canvasId, nodeId, readOnly, refreshKey, assetIdsForKind]);

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

  if (!runs.length && !sourceRuns.some((run) => ['failed', 'cancelled', 'needs_attention'].includes(run.status))) return null;
  return <div className="canvas-node-history">
    <Space><Typography.Text type="secondary" style={{ fontSize: 12 }}>生成历史 · {runs.reduce((sum, run) => sum + Math.max(1, assetIdsForKind(run).length), 0)}</Typography.Text><RunRecovery runs={sourceRuns} currentAssetId={currentAssetId} readOnly={readOnly} control={control} onRecovered={load} /></Space>
    <div className="canvas-node-history__rail">
      {runs.flatMap((run) => kind === 'text' ? [<div key={run.id}><button type="button" key={run.id} disabled={readOnly} className={`canvas-node-history__text${run.candidateGroup?.selectedRunId === run.id ? ' is-current' : ''}`} onClick={() => void chooseText(run)}>{promptModeLabel(run, promptModeContext) ? <span className={`canvas-node-history__mode ${promptModeLabel(run, promptModeContext) === '视频提示词' ? 'is-video' : ''}`}>{promptModeLabel(run, promptModeContext)}</span> : null}<span className="canvas-node-history__text-summary">{textSummary(run.outputText || '')}</span><RunDuration timestamps={run} />{seedActions(run)}{run.candidateGroup?.selectedRunId === run.id ? <span className="canvas-node-history__current" title="当前版本" aria-label="当前版本"><CheckOutlined /></span> : null}</button></div>] : assetIdsForKind(run).map((assetId) => {
        const current = selectedAssetIdForKind(run) === assetId;
        return <div key={assetId} className={`canvas-node-history__media${current ? ' is-current' : ''}`}>
          {kind === 'audio' ? <ViewportAudio controls src={`/api/assets/${assetId}`} style={{ width: '100%' }} /> : <button type="button" className="canvas-media-trigger canvas-media-trigger--history" onClick={() => setPreviewIndex(mediaItems.findIndex((item) => item.assetId === assetId))} aria-label={`放大预览${kind === 'video' ? '视频' : '图片'}`}>{kind === 'video' ? <><ViewportVideo src={`/api/assets/${assetId}`} muted playsInline preload="metadata" /><PlayCircleFilled className="canvas-media-trigger__play" /></> : <ViewportImage src={`/api/assets/${assetId}`} alt="历史图片产物" />}</button>}
          <AssetIdLabel assetId={assetId} />
          <RecoveryLabel recovery={run.recovery} />
          {run.recovery ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>补录时间：{new Date(run.recovery.recoveredAt).toLocaleString()}</Typography.Text> : <RunDuration timestamps={run} />}
          {run.recovery ? null : seedActions(run)}
          <Space size={2} wrap>{current ? <Tag color="blue" icon={<CheckOutlined />}>当前</Tag> : <Button size="small" disabled={readOnly} onClick={() => void chooseAsset(run, assetId)}>使用</Button>}<Button size="small" type="text" icon={<DownloadOutlined />} href={`/api/assets/${assetId}/download`} download aria-label="下载历史产物" /></Space>
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
