import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from 'antd';

export interface RunTimestamps { queuedAt?: number | null; startedAt?: number | null; finishedAt?: number | null; }

function validTime(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }

export function elapsedMs(from?: number | null, to?: number | null) {
  if (!validTime(from) || !validTime(to) || to! < from!) return null;
  return to! - from!;
}

export function formatClock(milliseconds: number | null) {
  if (milliseconds == null || milliseconds < 0 || !Number.isFinite(milliseconds)) return '--:--';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':') : [minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

export function formatDuration(milliseconds: number | null) {
  if (milliseconds == null || milliseconds < 0 || !Number.isFinite(milliseconds)) return '耗时不可用';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `耗时 ${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${rest}秒`;
}

export function timingDetails(timestamps: RunTimestamps) {
  const completed = validTime(timestamps.finishedAt) ? new Date(timestamps.finishedAt!).toLocaleString('zh-CN', { hour12: false }) : '不可用';
  return `实际运行：${formatDuration(elapsedMs(timestamps.startedAt, timestamps.finishedAt))}\n排队：${formatDuration(elapsedMs(timestamps.queuedAt, timestamps.startedAt))}\n总计：${formatDuration(elapsedMs(timestamps.queuedAt, timestamps.finishedAt))}\n完成时间：${completed}`;
}

export function RunElapsed({ status, queuedAt, startedAt }: RunTimestamps & { status?: string }) {
  const [now, setNow] = useState(Date.now());
  const running = status === 'running';
  const queued = status === 'pending' || status === 'queued';
  useEffect(() => {
    if (!running && !queued) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [queued, running]);
  const start = running && validTime(startedAt) ? startedAt : queued && validTime(queuedAt) ? queuedAt : null;
  const duration = useMemo(() => elapsedMs(start, now), [now, start]);
  if ((!running && !queued) || start == null) return null;
  return <span className="canvas-run-elapsed">{running ? '运行中' : '排队中'} {formatClock(duration)}</span>;
}

export function RunDuration({ timestamps }: { timestamps: RunTimestamps }) {
  return <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{timingDetails(timestamps)}</span>}><span className="canvas-run-duration">{formatDuration(elapsedMs(timestamps.startedAt, timestamps.finishedAt))}</span></Tooltip>;
}
