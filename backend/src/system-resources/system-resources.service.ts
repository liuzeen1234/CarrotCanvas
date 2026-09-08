import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { cpus, freemem, totalmem } from 'os';

export interface GpuResourceSample {
  index: number;
  name: string;
  usagePercent: number | null;
  temperatureC: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
}

export interface SystemResourceSnapshot {
  sampledAt: number;
  cpu: { usagePercent: number; temperatureC: number | null; temperatureSource: string | null };
  memory: { usagePercent: number; usedBytes: number; totalBytes: number };
  gpu: { available: boolean; provider: string | null; devices: GpuResourceSample[]; error: string | null };
}

interface CpuTimes { idle: number; total: number }

@Injectable()
export class SystemResourcesService {
  private cached: SystemResourceSnapshot | null = null;
  private inFlight: Promise<SystemResourceSnapshot> | null = null;
  private previousCpu = readCpuTimes();
  private readonly cacheMs = 1_000;

  async snapshot(): Promise<SystemResourceSnapshot> {
    if (this.cached && Date.now() - this.cached.sampledAt < this.cacheMs) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => { this.inFlight = null; });
    this.cached = await this.inFlight;
    return this.cached;
  }

  private async collect(): Promise<SystemResourceSnapshot> {
    let currentCpu = readCpuTimes();
    if (currentCpu.total <= this.previousCpu.total) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      currentCpu = readCpuTimes();
    }
    const usagePercent = cpuUsageBetween(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;

    const total = totalmem();
    const used = Math.max(0, total - freemem());
    const devices = await queryNvidiaGpus().catch(() => [] as GpuResourceSample[]);
    return {
      sampledAt: Date.now(),
      cpu: {
        usagePercent,
        // Windows does not expose a reliable CPU package temperature API. Optional sensor
        // providers can be added here later without changing the public response shape.
        temperatureC: null,
        temperatureSource: null,
      },
      memory: {
        usagePercent: total > 0 ? roundPercent((used / total) * 100) : 0,
        usedBytes: used,
        totalBytes: total,
      },
      gpu: {
        available: devices.length > 0,
        provider: devices.length ? 'nvidia-smi' : null,
        devices,
        error: devices.length ? null : 'GPU 指标不可用或驱动工具未安装',
      },
    };
  }
}

export function readCpuTimes(): CpuTimes {
  return cpus().reduce((sum, cpu) => {
    const values = Object.values(cpu.times);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + values.reduce((a, b) => a + b, 0) };
  }, { idle: 0, total: 0 });
}

export function cpuUsageBetween(previous: CpuTimes, current: CpuTimes): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return roundPercent((1 - idleDelta / totalDelta) * 100);
}

export function parseNvidiaSmi(output: string): GpuResourceSample[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 6) return [];
    const index = Number(parts[0]);
    if (!Number.isInteger(index)) return [];
    return [{
      index,
      name: parts[1] || `GPU ${index}`,
      usagePercent: nullableNumber(parts[2]),
      temperatureC: nullableNumber(parts[3]),
      memoryUsedBytes: mibToBytes(parts[4]),
      memoryTotalBytes: mibToBytes(parts[5]),
    }];
  });
}

async function queryNvidiaGpus(): Promise<GpuResourceSample[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 1_500, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
  return parseNvidiaSmi(output);
}

function nullableNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mibToBytes(value: string): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.round(parsed * 1024 * 1024);
}

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
