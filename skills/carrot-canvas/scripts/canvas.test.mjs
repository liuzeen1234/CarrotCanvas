import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, sleep } from './canvas.mjs';

function fixture() {
  const client = new CanvasClient();
  const calls = [];
  let holderId, pending = false, revision = 0, renewalError = false;
  let finishWrite;
  const slow = new Promise(r => { finishWrite = r; });
  client.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/acquire')) { holderId = body.holderId; return { epoch: 1, leaseToken: 'test-token', revision, status: 'active', holderId }; }
    if (path.endsWith('/renew')) {
      if (renewalError) throw Error('network unavailable');
      return { epoch: 1, status: pending ? 'handoff_pending' : 'active', holderId };
    }
    if (path.endsWith('/agent-view')) return { canvas: { revision, graph: { nodes: [], edges: [] } } };
    if (path.startsWith('/runs?')) return { items: [{ id: 'existing-run' }] };
    if (path.endsWith('/handoff') || path.endsWith('/release')) return { released: true };
    if (path.endsWith('/slow')) { await slow; return { resultRevision: ++revision }; }
    throw Error(`Unexpected ${method} ${path}`);
  };
  return { client, calls, finishWrite, requestHandoff: () => { pending = true; }, breakRenewal: () => { renewalError = true; } };
}

test('handoff drains an already-started graph mutation before release', async () => {
  const f = fixture();
  await f.client.withCanvas('canvas', async s => {
    const writing = s.write('POST', '/canvas/canvas/slow');
    while (!f.calls.some(c => c.path.endsWith('/slow'))) await sleep(1);
    f.requestHandoff(); await s.heartbeat();
    assert.equal(s.state, 'draining');
    assert(!f.calls.some(c => c.path.endsWith('/handoff')));
    assert.throws(() => s.operations([]), { code: 'SESSION_STOPPED' });
    f.finishWrite(); await writing; await s.done;
    const handoff = f.calls.find(c => c.path.endsWith('/handoff'));
    assert.equal(handoff.body.expectedRevision, 1);
    assert.equal(handoff.body.actorType, 'agent');
    assert.equal(f.calls.filter(c => c.path.endsWith('/handoff')).length, 1);
  });
});

test('provider generation may complete after handoff without holding the lease', async () => {
  const f = fixture();
  await f.client.withCanvas('canvas', async s => {
    const generation = s.write('POST', '/provider/slow', { canvasId: 'canvas' }, { providerRun: true });
    while (!f.calls.some(c => c.path.endsWith('/slow'))) await sleep(1);
    f.requestHandoff(); await s.heartbeat(); await s.done;
    assert.equal(s.state, 'released');
    f.finishWrite(); await generation;
    assert.throws(() => s.operations([]), { code: 'SESSION_STOPPED' });
  });
});

test('uncertain renewal closes write gate, releases, and never reacquires', async () => {
  const f = fixture();
  await assert.rejects(f.client.withCanvas('canvas', async s => {
    f.breakRenewal();
    await assert.rejects(s.heartbeat(), /network unavailable/);
    assert.throws(() => s.operations([]), { code: 'SESSION_STOPPED' });
  }), /network unavailable/);
  assert.equal(f.calls.filter(c => c.path.endsWith('/acquire')).length, 1);
  assert(f.calls.some(c => c.path.endsWith('/handoff') || c.path.endsWith('/release')));
});
