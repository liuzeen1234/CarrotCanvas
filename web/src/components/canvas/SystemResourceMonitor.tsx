import { useEffect, useMemo, useState } from 'react';
import { Button, Popover, Tooltip } from 'antd';
import { DashboardOutlined, MinusOutlined } from '@ant-design/icons';
import { request } from 'umi';
import './SystemResourceMonitor.css';

interface GpuSample {
  index: number;
  name: string;
  usagePercent: number | null;
  temperatureC: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
}

interface ResourceSnapshot {
  sampledAt: number;
  cpu: { usagePercent: number; temperatureC: number | null };
  memory: { usagePercent: number; usedBytes: number; totalBytes: number };
  gpu: { available: boolean; provider: string | null; devices: GpuSample[]; error: string | null };
}

const STORAGE_KEY = 'carrot-canvas:resource-monitor-collapsed';

export default function SystemResourceMonitor() {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(STORAGE_KEY) === '1');
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (disposed) return;
      const delay = document.hidden ? 15_000 : collapsed ? 10_000 : 2_000;
      timer = setTimeout(sample, delay);
    };
    const sample = async () => {
      try {
        const next = await request<ResourceSnapshot>('/api/system/resources');
        if (!disposed) { setSnapshot(next); setUnavailable(false); }
      } catch {
        if (!disposed) setUnavailable(true);
      } finally {
        schedule();
      }
    };
    const visibilityChanged = () => {
      if (timer) clearTimeout(timer);
      schedule();
    };
    void sample();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [collapsed]);

  const gpus = snapshot?.gpu.devices ?? [];
  const primaryGpu = useMemo(() => gpus.reduce<GpuSample | null>((best, gpu) => {
    if (!best) return gpu;
    return (gpu.usagePercent ?? -1) > (best.usagePercent ?? -1) ? gpu : best;
  }, null), [gpus]);

  const setFolded = (value: boolean) => {
    setCollapsed(value);
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  };

  if (collapsed) {
    return <Tooltip title="展开系统资源监控"><Button className="resource-monitor__toggle" shape="circle" icon={<DashboardOutlined />} onClick={() => setFolded(false)} aria-label="展开系统资源监控" /></Tooltip>;
  }

  const cpuUsage = snapshot?.cpu.usagePercent ?? null;
  const memoryUsage = snapshot?.memory.usagePercent ?? null;
  const gpuUsage = primaryGpu?.usagePercent ?? null;
  return <div className="resource-monitor" aria-label="系统资源监控">
    <Button className="resource-monitor__collapse" size="small" type="text" icon={<MinusOutlined />} onClick={() => setFolded(true)} aria-label="折叠系统资源监控" />
    <MetricRing
      label="CPU"
      usage={cpuUsage}
      center={snapshot?.cpu.temperatureC != null ? `${Math.round(snapshot.cpu.temperatureC)}°C` : cpuUsage != null ? `${Math.round(cpuUsage)}%` : '—'}
      title={snapshot?.cpu.temperatureC != null ? `CPU ${cpuUsage}% · ${snapshot.cpu.temperatureC}°C` : `CPU ${cpuUsage ?? '不可用'}% · 温度不可用`}
    />
    <Popover trigger="click" placement="bottomRight" content={<GpuDetails devices={gpus} error={snapshot?.gpu.error} />}>
      <div className="resource-monitor__metric-button" role="button" tabIndex={0} aria-label="查看 GPU 详情">
        <MetricRing
          label="GPU"
          usage={gpuUsage}
          center={primaryGpu?.temperatureC != null ? `${Math.round(primaryGpu.temperatureC)}°C` : gpuUsage != null ? `${Math.round(gpuUsage)}%` : '—'}
          title={primaryGpu ? `${primaryGpu.name} · 使用率 ${gpuUsage ?? '不可用'}% · 温度 ${primaryGpu.temperatureC ?? '不可用'}°C` : 'GPU 指标不可用'}
          badge={gpus.length > 1 ? `${gpus.length}卡` : undefined}
        />
      </div>
    </Popover>
    <MetricRing
      label="内存"
      usage={memoryUsage}
      center={memoryUsage != null ? `${Math.round(memoryUsage)}%` : '—'}
      title={snapshot ? `内存 ${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}` : '内存指标加载中'}
    />
    {unavailable ? <span className="resource-monitor__offline" title="资源接口暂时不可用">!</span> : null}
  </div>;
}

function MetricRing({ label, usage, center, title, badge }: { label: string; usage: number | null; center: string; title: string; badge?: string }) {
  const value = usage == null ? 0 : Math.max(0, Math.min(100, usage));
  const radius = 24;
  const circumference = 2 * Math.PI * radius;
  const color = usage == null ? '#d9d9d9' : value >= 90 ? '#ff4d4f' : value >= 70 ? '#fa8c16' : '#1677ff';
  return <Tooltip title={title}>
    <div className="resource-ring" role="progressbar" aria-label={`${label} 使用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage == null ? undefined : Math.round(value)}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle className="resource-ring__track" cx="30" cy="30" r={radius} />
        <circle className="resource-ring__value" cx="30" cy="30" r={radius} stroke={color} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
      </svg>
      <span className="resource-ring__center">{center}</span>
      <span className="resource-ring__label">{label}</span>
      {badge ? <span className="resource-ring__badge">{badge}</span> : null}
    </div>
  </Tooltip>;
}

function GpuDetails({ devices, error }: { devices: GpuSample[]; error?: string | null }) {
  if (!devices.length) return <div style={{ color: '#8c8c8c' }}>{error || 'GPU 指标不可用'}</div>;
  return <div className="resource-gpu-details">{devices.map((gpu) => <div key={gpu.index} className="resource-gpu-details__item">
    <strong>GPU {gpu.index} · {gpu.name}</strong>
    <span>使用率：{gpu.usagePercent == null ? '不可用' : `${gpu.usagePercent}%`}</span>
    <span>温度：{gpu.temperatureC == null ? '不可用' : `${gpu.temperatureC}°C`}</span>
    <span>显存：{gpu.memoryUsedBytes == null || gpu.memoryTotalBytes == null ? '不可用' : `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`}</span>
  </div>)}</div>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 GB';
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
