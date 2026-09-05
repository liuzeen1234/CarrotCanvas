import { AgentLeaseGuard, type AgentCanvasLease, type AgentLeaseTransport } from './agent-lease-guard';

function lease(status: AgentCanvasLease['status'] = 'active'): AgentCanvasLease {
  return { leaseToken: 'secret', epoch: 2, status, revision: 7 };
}

describe('AgentLeaseGuard', () => {
  afterEach(() => jest.useRealTimers());

  it('续租发现 handoff_pending 后停止新写入、排空并主动释放', async () => {
    const events: string[] = [];
    const transport: AgentLeaseTransport = {
      acquire: jest.fn(async () => lease()),
      renew: jest.fn(async () => lease('handoff_pending')),
      release: jest.fn(async () => { events.push('release'); }),
    };
    const guard = new AgentLeaseGuard({
      canvasId: 'canvas-1', holderId: 'agent-1', transport, heartbeatMs: 10_000,
      onHandoffRequested: async () => { events.push('drain'); expect(guard.canStartWrite).toBe(false); expect(guard.state).toBe('draining'); },
    });

    await guard.start();
    expect(guard.canStartWrite).toBe(true);
    await guard.heartbeatNow();

    expect(events).toEqual(['drain', 'release']);
    expect(transport.release).toHaveBeenCalledWith('canvas-1', expect.objectContaining({ epoch: 2 }));
    expect(guard.state).toBe('released');
    expect(guard.proof).toBeNull();
  });

  it('定时续租保持 active，但任务 stop 时主动释放', async () => {
    jest.useFakeTimers();
    const transport: AgentLeaseTransport = {
      acquire: jest.fn(async () => lease()), renew: jest.fn(async () => lease()), release: jest.fn(async () => undefined),
    };
    const guard = new AgentLeaseGuard({ canvasId: 'canvas-1', holderId: 'agent-1', transport, heartbeatMs: 100 });
    await guard.start();
    await jest.advanceTimersByTimeAsync(100);
    expect(transport.renew).toHaveBeenCalledTimes(1);
    expect(guard.state).toBe('active');
    await guard.stop();
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(guard.state).toBe('released');
  });

  it('旧 epoch 或租约失效后进入 lost，绝不自动重新 acquire', async () => {
    const error = Object.assign(new Error('STALE_LEASE'), { status: 409 });
    const onLeaseLost = jest.fn();
    const transport: AgentLeaseTransport = {
      acquire: jest.fn(async () => lease()), renew: jest.fn(async () => { throw error; }), release: jest.fn(),
    };
    const guard = new AgentLeaseGuard({ canvasId: 'canvas-1', holderId: 'agent-1', transport, onLeaseLost });
    await guard.start();
    await guard.heartbeatNow();
    expect(guard.state).toBe('lost');
    expect(guard.canStartWrite).toBe(false);
    expect(transport.acquire).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledWith(error);
  });
});
