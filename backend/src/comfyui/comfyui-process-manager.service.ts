import { BadRequestException, ConflictException, GoneException, Injectable, Logger, PreconditionFailedException } from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, openSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { SettingsService } from '../settings/settings.service';
import { ComfyUIClientService } from './comfyui-client';

const execFileAsync = promisify(execFile);
type LaunchSpec = { executable: string; args: string[]; cwd: string };
type ProcessInfo = { pid: number; name: string; path: string | null; workingSetBytes: number; privateBytes: number };
type TakeoverConfirmation = { fingerprint: string; expiresAt: number };

@Injectable()
export class ComfyUIProcessManagerService {
  private readonly logger = new Logger(ComfyUIProcessManagerService.name);
  private child: ChildProcess | null = null;
  private readonly confirmations = new Map<string, TakeoverConfirmation>();
  constructor(private readonly settings: SettingsService, private readonly client: ComfyUIClientService) {}

  async ensureManagedRunning() {
    const inspection = await this.inspect();
    if (inspection.desktopProcesses.length && !inspection.portOwner) throw new ConflictException({
      code: 'COMFYUI_TAKEOVER_REQUIRED', message: '检测到外部 ComfyUI Desktop，拒绝并行启动托管后端', ...inspection,
    });
    if (inspection.portOwner) {
      if (await this.isManagedProcess(inspection.portOwner)) return inspection;
      throw new ConflictException({
        code: 'COMFYUI_TAKEOVER_REQUIRED',
        message: '检测到非调度器启动的 ComfyUI 或 ComfyUI Desktop，任务已中断，请确认是否交由 CarrotCanvas 托管',
        ...inspection,
      });
    }
    const launch = await this.readLaunchSpec();
    if (!launch) throw new PreconditionFailedException({
      code: 'COMFYUI_LAUNCH_NOT_CONFIGURED',
      message: '尚未保存 ComfyUI 后端启动方式；请先在检测到 Desktop 时确认一次接管',
    });
    return this.start(launch);
  }

  async releaseBeforeOtherProvider() {
    const inspection = await this.inspect();
    if (!inspection.portOwner) return { stopped: true, attempts: [] };
    if (!await this.isManagedProcess(inspection.portOwner)) {
      throw new ConflictException({
        code: 'COMFYUI_TAKEOVER_REQUIRED',
        message: '检测到外部 ComfyUI/Desktop，拒绝在其可能占用资源时加载其他 Provider',
        ...inspection,
      });
    }
    return this.releaseManaged();
  }

  async releaseManaged() {
    const attempts: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = await this.inspect();
      if (!before.portOwner) return { stopped: true, attempts };
      if (!await this.isManagedProcess(before.portOwner)) {
        throw new ConflictException({ code: 'COMFYUI_TAKEOVER_REQUIRED', message: '8188 已被外部 ComfyUI 接管，拒绝自动结束', ...before });
      }
      const outcome = await this.killTree(before.portOwner.pid);
      await delay(1_000);
      const after = await this.inspect();
      attempts.push({ attempt, before, after, outcome });
      const processAlive = await this.processExists(before.portOwner.pid);
      if (!after.portOwner && !processAlive) { this.child = null; await this.settings.set('comfyui-managed-process', null); return { stopped: true, attempts }; }
    }
    const error = new Error('ComfyUI 连续 3 次仍未释放端口/内存，已中断 Provider 切换');
    (error as Error & { details?: unknown }).details = { code: 'PROVIDER_RELEASE_FAILED', provider: 'comfyui', attempts };
    throw error;
  }

  async requestTakeoverConfirmation() {
    const inspection = await this.inspect();
    if (!inspection.portOwner && !inspection.desktopProcesses.length) throw new ConflictException({
      code: 'COMFYUI_TAKEOVER_NOT_REQUIRED', message: '当前没有需要接管的外部 ComfyUI 或 Desktop', ...inspection,
    });
    if (inspection.portOwner && await this.isManagedProcess(inspection.portOwner)) throw new ConflictException({
      code: 'COMFYUI_ALREADY_MANAGED', message: '当前 ComfyUI 已由调度器托管，无需确认接管', ...inspection,
    });
    if (inspection.portOwner) this.deriveLaunchSpec(inspection.portOwner, await this.client.getSystemStats());
    this.pruneConfirmations();
    const confirmationToken = randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    const fingerprint = this.fingerprint(inspection);
    this.confirmations.set(confirmationToken, { fingerprint, expiresAt });
    return { confirmationToken, expiresAt, fingerprint: this.publicFingerprint(fingerprint), inspection };
  }

  async takeover(confirmationToken: string, alwaysManage = true) {
    if (!confirmationToken) throw new BadRequestException({ code: 'TAKEOVER_CONFIRMATION_REQUIRED', message: '缺少一次性接管确认令牌' });
    const confirmation = this.confirmations.get(confirmationToken);
    this.confirmations.delete(confirmationToken);
    if (!confirmation) throw new BadRequestException({ code: 'TAKEOVER_CONFIRMATION_INVALID', message: '接管确认令牌无效或已使用' });
    if (confirmation.expiresAt < Date.now()) throw new GoneException({ code: 'TAKEOVER_CONFIRMATION_EXPIRED', message: '接管确认已过期，请重新检查进程并确认' });
    const before = await this.inspect();
    if (this.fingerprint(before) !== confirmation.fingerprint) throw new ConflictException({
      code: 'TAKEOVER_CONFIRMATION_STALE', message: 'ComfyUI/Desktop 进程已变化，旧确认已失效，请重新确认', ...before,
    });
    if (!before.portOwner) throw new ConflictException({ code: 'COMFYUI_TAKEOVER_NOT_REQUIRED', message: 'ComfyUI 端口已释放，不再执行接管', ...before });
    const stats = await this.client.getSystemStats();
    const launch = this.deriveLaunchSpec(before.portOwner, stats);
    await this.settings.set('comfyui-managed-launch', JSON.stringify(launch));
    await this.settings.set('comfyui-always-managed', alwaysManage ? 'true' : 'false');
    const attempts: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = await this.inspect();
      const targets = [...new Set([...current.desktopProcesses.map((item) => item.pid), ...(current.portOwner ? [current.portOwner.pid] : [])])];
      const outcomes = [];
      for (const pid of targets) outcomes.push({ pid, outcome: await this.killTree(pid) });
      await delay(1_500);
      const after = await this.inspect();
      attempts.push({ attempt, after, outcomes });
      if (!after.portOwner && !after.desktopProcesses.length) return { takeover: true, attempts, running: await this.start(launch) };
    }
    throw new ConflictException({ code: 'COMFYUI_TAKEOVER_FAILED', message: '连续 3 次仍无法关闭 ComfyUI Desktop/相关进程，未启动托管服务', before, attempts });
  }

  async inspect() {
    const [portOwner, desktopProcesses, globalGpuMemoryUsedBytes] = await Promise.all([
      this.inspectPort(8188), this.inspectByName('Comfy Desktop'), this.inspectGlobalGpuMemory(),
    ]);
    let allocator: unknown = null;
    if (portOwner) {
      try {
        const stats = await this.client.getSystemStats();
        allocator = (stats.devices as unknown[] | undefined)?.[0] ?? null;
      } catch { /* 端口可能不是 ComfyUI。 */ }
    }
    return { port: 8188, portOwner, desktopProcesses, allocator, globalGpuMemoryUsedBytes };
  }

  private async start(launch: LaunchSpec) {
    if (!existsSync(launch.executable) || !existsSync(launch.cwd)) throw new Error('保存的 ComfyUI 启动路径已不存在');
    const logs = resolve(__dirname, '..', '..', 'data', 'comfyui-managed-logs');
    mkdirSync(logs, { recursive: true });
    const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, windowsHide: true,
      stdio: ['ignore', openSync(join(logs, 'stdout.log'), 'a'), openSync(join(logs, 'stderr.log'), 'a')] });
    this.child = child;
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.once('exit', () => { if (this.child === child) this.child = null; });
    try {
    await this.settings.set('comfyui-managed-process', JSON.stringify({ pid: child.pid, executable: launch.executable, startedAt: Date.now() }));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { await this.client.getSystemStats(); return this.inspect(); }
      catch { if (child.exitCode !== null) throw new Error(`托管 ComfyUI 提前退出，exitCode=${child.exitCode}`); await delay(500); }
    }
    throw new Error('托管 ComfyUI 在 120 秒内未通过健康检查');
    } catch (error) {
      // A failed boot can leave a Python process alive without an 8188 listener.
      // Only clean up the exact child spawned here; never kill a discovered external owner.
      if (child.pid) {
        await this.killTree(child.pid);
        if (await this.processExists(child.pid)) throw Object.assign(new Error('ComfyUI 启动失败且进程未能退出'), {
          details: { code: 'PROVIDER_STATE_UNCONFIRMED', provider: 'comfyui', pid: child.pid, cause: (error as Error).message },
        });
      }
      if (this.child === child) this.child = null;
      await this.settings.set('comfyui-managed-process', null);
      throw error;
    }
  }

  private async isManagedProcess(owner: ProcessInfo) {
    if (this.child?.pid === owner.pid && this.child.exitCode === null) return true;
    const saved = await this.settings.get('comfyui-managed-process');
    if (!saved?.value) return false;
    try {
      const process = JSON.parse(saved.value) as { pid?: number; executable?: string };
      return Number(process.pid) === owner.pid && !!owner.path && resolve(String(process.executable)).toLowerCase() === resolve(owner.path).toLowerCase();
    } catch { return false; }
  }

  private async readLaunchSpec(): Promise<LaunchSpec | null> {
    const saved = await this.settings.get('comfyui-managed-launch');
    if (!saved?.value) return null;
    try { return JSON.parse(saved.value) as LaunchSpec; } catch { return null; }
  }

  private fingerprint(inspection: { portOwner: ProcessInfo | null; desktopProcesses: ProcessInfo[] }) {
    const identity = (item: ProcessInfo) => ({ pid: item.pid, name: item.name, path: item.path });
    return JSON.stringify({
      portOwner: inspection.portOwner ? identity(inspection.portOwner) : null,
      desktopProcesses: inspection.desktopProcesses.map(identity).sort((a, b) => a.pid - b.pid),
    });
  }
  private publicFingerprint(fingerprint: string) { return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16); }
  private pruneConfirmations() {
    const now = Date.now();
    for (const [token, value] of this.confirmations) if (value.expiresAt < now) this.confirmations.delete(token);
  }

  private deriveLaunchSpec(owner: ProcessInfo, stats: Record<string, unknown>): LaunchSpec {
    if (!owner.path) throw new Error('无法读取 ComfyUI Python 路径，不能安全保存重启配置');
    const argv = ((stats.system as { argv?: unknown[] } | undefined)?.argv ?? []).map(String);
    if (!argv.length) throw new Error('ComfyUI /system_stats 未返回启动参数');
    let cursor = dirname(owner.path);
    for (let level = 0; level < 4; level += 1) {
      if (existsSync(join(cursor, argv[0]))) return { executable: owner.path, args: argv, cwd: cursor };
      cursor = dirname(cursor);
    }
    throw new Error(`无法根据 ${argv[0]} 推导 ComfyUI 工作目录，拒绝接管`);
  }

  private async inspectPort(port: number): Promise<ProcessInfo | null> {
    const script = `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){$p=Get-Process -Id $c.OwningProcess -ErrorAction Stop;[pscustomobject]@{pid=$p.Id;name=$p.ProcessName;path=$p.Path;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64}|ConvertTo-Json -Compress}`;
    return this.runInspection(script, false) as Promise<ProcessInfo | null>;
  }
  private async inspectByName(name: string): Promise<ProcessInfo[]> {
    const safe = name.replace(/'/g, "''");
    const script = `$p=Get-Process -Name '${safe}' -ErrorAction SilentlyContinue;if($p){@($p|ForEach-Object{[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;path=$_.Path;workingSetBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64}})|ConvertTo-Json -Compress}`;
    return this.runInspection(script, true) as Promise<ProcessInfo[]>;
  }
  private async processExists(pid: number) {
    const script = `if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){'true'}else{'false'}`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 5_000 });
      return stdout.trim().toLowerCase() === 'true';
    } catch { return true; }
  }
  private async inspectGlobalGpuMemory(): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('nvidia-smi.exe', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5_000 });
      const mib = Number(stdout.trim().split(/\r?\n/)[0]);
      return Number.isFinite(mib) ? mib * 1024 * 1024 : null;
    } catch { return null; }
  }
  private async runInspection(script: string, array: boolean) {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 5_000 });
      const trimmed = stdout.trim(); if (!trimmed) return array ? [] : null;
      const parsed = JSON.parse(trimmed); return array ? (Array.isArray(parsed) ? parsed : [parsed]) : parsed;
    } catch (error) { this.logger.warn(`进程检查失败：${(error as Error).message}`); return array ? [] : null; }
  }
  private async killTree(pid: number) {
    try { const { stdout, stderr } = await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }); return `${stdout}${stderr}`.trim(); }
    catch (error) { return (error as Error).message; }
  }
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
