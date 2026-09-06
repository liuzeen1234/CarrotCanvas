/**
 * Agent 侧画布 lease 生命周期守护器。
 *
 * 关键约束：heartbeat 不只是保活。每次 renew 都必须解析状态；一旦服务端返回
 * handoff_pending，立即禁止新写入，等待调用方排空已开始的最小收尾，然后主动 release。
 */
export interface AgentCanvasLease {
  leaseToken: string;
  epoch: number;
  status: 'active' | 'handoff_pending';
  revision?: number;
}

export interface AgentLeaseTransport {
  acquire(canvasId: string, holderId: string): Promise<AgentCanvasLease>;
  renew(canvasId: string, lease: AgentCanvasLease): Promise<AgentCanvasLease>;
  release(canvasId: string, lease: AgentCanvasLease): Promise<void>;
}

export type AgentLeaseGuardState = 'idle' | 'active' | 'draining' | 'released' | 'lost';

export interface AgentLeaseGuardOptions {
  canvasId: string;
  holderId: string;
  transport: AgentLeaseTransport;
  heartbeatMs?: number;
  /** 停止接收新工作后，排空已经开始且不可安全中断的最小写入。 */
  onHandoffRequested?: () => Promise<void> | void;
  onLeaseLost?: (error: unknown) => Promise<void> | void;
}

export class AgentLeaseGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  private lease: AgentCanvasLease | null = null;
  private stateValue: AgentLeaseGuardState = 'idle';

  constructor(private readonly options: AgentLeaseGuardOptions) {}

  get state() { return this.stateValue; }
  get proof() { return this.lease ? { leaseToken: this.lease.leaseToken, leaseEpoch: this.lease.epoch } : null; }
  get canStartWrite() { return this.stateValue === 'active'; }

  async start(): Promise<AgentCanvasLease> {
    if (this.stateValue !== 'idle') throw new Error(`lease guard cannot start from ${this.stateValue}`);
    this.lease = await this.options.transport.acquire(this.options.canvasId, this.options.holderId);
    this.stateValue = 'active';
    this.schedule();
    return this.lease;
  }

  /** 暴露单次 heartbeat，供测试、长任务边界或没有常驻事件循环的 Agent 主动调用。 */
  async heartbeatNow(): Promise<void> {
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    if (this.stateValue !== 'active' || !this.lease) return;
    this.heartbeatInFlight = this.runHeartbeat().finally(() => { this.heartbeatInFlight = null; });
    return this.heartbeatInFlight;
  }

  async stop(): Promise<void> {
    this.clearTimer();
    if (!this.lease || !['active', 'draining'].includes(this.stateValue)) return;
    const lease = this.lease;
    this.stateValue = 'draining';
    try { await this.options.transport.release(this.options.canvasId, lease); }
    finally { this.stateValue = 'released'; this.lease = null; }
  }

  private async runHeartbeat(): Promise<void> {
    const lease = this.lease!;
    try {
      const renewed = await this.options.transport.renew(this.options.canvasId, lease);
      this.lease = { ...lease, ...renewed, leaseToken: renewed.leaseToken || lease.leaseToken };
      if (renewed.status === 'handoff_pending') {
        this.clearTimer();
        this.stateValue = 'draining';
        try { await this.options.onHandoffRequested?.(); }
        finally {
          await this.options.transport.release(this.options.canvasId, this.lease);
          this.stateValue = 'released';
          this.lease = null;
        }
        return;
      }
      this.schedule();
    } catch (error) {
      this.clearTimer();
      this.stateValue = 'lost';
      this.lease = null;
      await this.options.onLeaseLost?.(error);
    }
  }

  private schedule() {
    this.clearTimer();
    if (this.stateValue !== 'active') return;
    this.timer = setTimeout(() => void this.heartbeatNow(), this.options.heartbeatMs ?? 10_000);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** 基于公开 Canvas Control API 的默认 transport，可直接用于外部 Node Agent。 */
export class HttpAgentLeaseTransport implements AgentLeaseTransport {
  constructor(private readonly baseUrl = 'http://localhost:3100/api') {}

  acquire(canvasId: string, holderId: string) {
    return this.post<AgentCanvasLease>(`/canvas/${canvasId}/control/acquire`, { holderType: 'agent', holderId });
  }

  renew(canvasId: string, lease: AgentCanvasLease) {
    return this.post<AgentCanvasLease>(`/canvas/${canvasId}/control/renew`, { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch });
  }

  async release(canvasId: string, lease: AgentCanvasLease) {
    await this.post(`/canvas/${canvasId}/control/release`, { leaseToken: lease.leaseToken, leaseEpoch: lease.epoch });
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error((payload as any)?.message || `HTTP ${response.status}`), { status: response.status, payload });
    return payload as T;
  }
}
