// Explicit, zero-generation HTTP acceptance. Creates and cleans up its own canvas only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasClient, sleep } from './canvas.mjs';

const client = new CanvasClient();
const checks = [];
const canvas = await client.request('POST', '/canvas', { name: `Skill acceptance ${new Date().toISOString()}` });
const directory = await mkdtemp(join(tmpdir(), 'carrot-skill-'));
try {
  const registry = await client.get('/actions');
  assert(registry.actions.some(a => a.name === 'canvas.operations'));
  await client.withCanvas(canvas.id, async s => {
    await s.operations([
      { type: 'create_node', node: { id: 'input', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'text', inputMode: true, lastText: '跨项目测试' } } },
      { type: 'create_node', node: { id: 'output', type: 'result', position: { x: 400, y: 0 }, data: { kind: 'text' } } },
      { type: 'connect', edge: { id: 'edge', source: 'input', target: 'output', sourceHandle: 'text-source', targetHandle: 'text-target' } },
    ], 'Skill isolated cross-project acceptance', 'initial-graph');
    assert.equal(s.revision, 1); checks.push('create nodes + typed edge + revision');
    const proof = { ...s.proof };
    await s.operations([{ type: 'move_nodes', positions: [{ nodeId: 'input', position: { x: 20, y: 30 } }] }], 'Move node');
    await assert.rejects(client.request('POST', `${s.path}/operations`, { ...proof, idempotencyKey: 'stale', operations: [{ type: 'rename_canvas', name: 'must not happen' }] }), e => e.code === 'REVISION_CONFLICT');
    assert.equal((await s.refresh()).canvas.revision, 2); checks.push('stale revision rejected without overwrite');
    const current = { ...s.proof, idempotencyKey: 'replay', operations: [{ type: 'rename_canvas', name: 'Skill isolated acceptance' }] };
    await client.request('POST', `${s.path}/operations`, current);
    assert.equal((await client.request('POST', `${s.path}/operations`, current)).replayed, true);
    await s.refresh(); assert.equal(s.revision, 3); checks.push('idempotent replay no duplicate revision');
    await assert.rejects(s.operations([{ type: 'create_node', node: { id: 'bad', type: 'unknown', position: { x: 0, y: 0 }, data: {} } }]), e => e.code === 'UNSUPPORTED_NODE_TYPE');
    assert.equal((await s.refresh()).canvas.graph.nodes.length, 2); checks.push('invalid batch atomic rejection');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=', 'base64');
    const input = join(directory, 'fixture.png'); await writeFile(input, png);
    const uploaded = await s.uploadMedia(input, 'image', 'input');
    assert(uploaded.asset.assetId);
    const output = join(directory, 'download.png');
    await client.download(uploaded.asset.assetId, output);
    assert.deepEqual(await readFile(output), png);
    await assert.rejects(client.download(uploaded.asset.assetId, output), e => e.code === 'EEXIST');
    checks.push('multipart upload + byte-exact download + overwrite protection');
    console.log('Graph/media checks passed; observing automatic lease renewal beyond 45-second TTL.');
    await sleep(47000);
    const status = await client.get(`${s.path}/control/status`);
    assert.equal(status.lease.holderId, s.holderId); assert.equal(status.status, 'active');
    checks.push('automatic renewal beyond initial 45-second TTL');
    await client.request('POST', `${s.path}/control/request-handoff`, { holderType: 'human', holderId: 'skill-acceptance-human' });
    await Promise.race([s.done, sleep(14000).then(() => { throw Error('Handoff did not release within heartbeat window'); })]);
    assert.throws(() => s.operations([{ type: 'rename_canvas', name: 'forbidden' }]), e => e.code === 'SESSION_STOPPED');
    const human = await client.request('POST', `${s.path}/control/acquire`, { holderType: 'human', holderId: 'skill-acceptance-human' });
    assert(human.epoch > proof.leaseEpoch);
    await client.request('POST', `${s.path}/control/release`, { leaseToken: human.leaseToken, leaseEpoch: human.epoch });
    checks.push('AI to human handoff + write gate + new epoch');
  });
  const human = await client.request('POST', `/canvas/${canvas.id}/control/acquire`, { holderType: 'human', holderId: 'skill-acceptance-human' });
  const holder = (async () => {
    for (let i = 0; i < 30; i++) {
      const state = await client.get(`/canvas/${canvas.id}/control/status`);
      if (state.status === 'handoff_pending') {
        await client.request('POST', `/canvas/${canvas.id}/control/release`, { leaseToken: human.leaseToken, leaseEpoch: human.epoch }); return;
      }
      await sleep(200);
    }
    throw Error('Agent did not request handoff');
  })();
  await Promise.all([holder, client.withCanvas(canvas.id, async s => {
    assert(s.lease.epoch > human.epoch);
    await s.operations([{ type: 'rename_canvas', name: 'Skill human-to-agent acceptance' }]);
  })]);
  checks.push('human to AI normal request/acquire');
  await assert.rejects(client.withCanvas(canvas.id, async () => { throw Error('intentional task failure'); }), /intentional task failure/);
  assert(!['active', 'handoff_pending'].includes((await client.get(`/canvas/${canvas.id}/control/status`)).status));
  checks.push('task failure releases lease');
  console.log(JSON.stringify({ passed: checks, canvasId: canvas.id, generationRuns: (await client.get(`/runs?canvasId=${canvas.id}`)).total }, null, 2));
} finally {
  // Cleanup is scoped to the exact canvas created by this invocation; no user canvas is selected.
  await client.withCanvas(canvas.id, s => s.write('DELETE', s.path, {}));
  const absolute = directory;
  if (!absolute.startsWith(join(tmpdir(), 'carrot-skill-'))) throw Error('Unexpected temporary directory');
  await rm(absolute, { recursive: true });
}
