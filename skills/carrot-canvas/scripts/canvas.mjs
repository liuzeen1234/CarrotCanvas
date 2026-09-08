import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Standalone Node 22+ client. All paths are relative to the configured API root. */
export class CanvasClient {
  constructor(baseUrl = process.env.CARROT_CANVAS_URL || 'http://localhost:3100/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  url(path) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw fail('INVALID_PATH', 'Use an API-relative path');
    return this.baseUrl + path.replace(/^\/api(?=\/)/, '');
  }
  async request(method, path, body, { timeoutMs = 15000 } = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(this.url(path), {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: body === undefined || multipart ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { message: raw.slice(0, 500) }; }
    if (!response.ok) throw Object.assign(new Error(payload?.message || `HTTP ${response.status}`), {
      code: payload?.code || 'HTTP_ERROR', status: response.status, payload,
    });
    return payload;
  }
  get(path) { return this.request('GET', path); }
  async download(assetId, destination) {
    const response = await fetch(this.url(`/assets/${encodeURIComponent(assetId)}/download`), {
      redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw fail('DOWNLOAD_FAILED', `HTTP ${response.status}`);
    await writeFile(resolve(destination), Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    return { path: resolve(destination), assetId };
  }
  async withCanvas(canvasId, work, options = {}) {
    const session = new CanvasSession(this, canvasId, options);
    const onSignal = () => { session.close('Process interrupted').finally(() => process.exit(130)); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    try { await session.start(); const result = await work(session); if (session.error) throw session.error; return result; }
    finally {
      try { await session.close(options.summary || 'Agent task ended; consult operation log and Run history.'); }
      finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
    }
  }
}

class CanvasSession {
  constructor(client, canvasId, options) {
    this.client = client; this.canvasId = canvasId; this.options = options;
    this.holderId = options.holderId || `carrot-skill-${randomUUID()}`;
    this.state = 'idle'; this.pending = new Set(); this.tail = Promise.resolve();
    this.done = new Promise(r => { this.resolveDone = r; });
    this.abort = new AbortController(); this.signal = this.abort.signal;
  }
  get path() { return `/canvas/${encodeURIComponent(this.canvasId)}`; }
  get proof() { return { leaseToken: this.lease?.leaseToken, leaseEpoch: this.lease?.epoch,
    expectedRevision: this.revision, actorType: 'agent', actorId: this.holderId }; }
  async start() {
    const identity = { holderType: 'agent', holderId: this.holderId };
    const deadline = Date.now() + (this.options.acquireTimeoutMs ?? 60000);
    let requested = false;
    while (true) {
      try { this.lease = await this.client.request('POST', `${this.path}/control/acquire`, identity); break; }
      catch (error) {
        if (error.status !== 423) throw error;
        if (!requested) { await this.client.request('POST', `${this.path}/control/request-handoff`, identity); requested = true; }
        if (Date.now() >= deadline) throw fail('HANDOFF_WAIT_TIMEOUT', 'Current holder has not released; do not force takeover');
        await sleep(1000);
      }
    }
    this.revision = this.lease.revision; this.state = 'active'; this.schedule();
    await this.refresh();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.state === 'active') this.timer = setTimeout(() => {
      this.heartbeat().catch(error => { this.error = error; void this.close('Lease status uncertain').catch(e => { this.error = e; }); });
    }, 10000);
  }
  async heartbeat() {
    if (this.beating) return this.beating;
    if (this.state !== 'active') return;
    this.beating = (async () => {
      const renewed = await this.client.request('POST', `${this.path}/control/renew`, this.proof, { timeoutMs: 5000 });
      if (renewed.epoch !== this.lease.epoch || renewed.holderId !== this.holderId || !['active', 'handoff_pending'].includes(renewed.status)) {
        throw fail('LEASE_LOST', 'Lease identity changed; stop writing');
      }
      this.lease = { ...this.lease, ...renewed };
      if (renewed.status === 'handoff_pending') {
        // Do not await close here: close waits for the heartbeat to finish.
        this.state = 'draining'; this.abort.abort('handoff_pending');
        void this.close('Human or another agent requested control.').catch(e => { this.error = e; });
      } else this.schedule();
    })().catch(error => {
      this.error = error; this.state = 'draining'; this.abort.abort('Lease status uncertain');
      clearTimeout(this.timer);
      throw error;
    }).finally(() => { this.beating = null; });
    return this.beating;
  }
  assertActive() {
    if (this.state !== 'active') throw fail('SESSION_STOPPED', `Canvas session is ${this.state}; no new writes`);
  }
  get(path) { return this.client.get(path); }
  async refresh() {
    const view = await this.get(`${this.path}/agent-view`);
    this.revision = view.canvas.revision; this.canvas = view.canvas;
    return view;
  }
  /** Serial writes; never retries or rebases an uncertain mutation automatically. */
  write(method, path, body = {}, { timeoutMs = 30000, providerRun = false } = {}) {
    this.assertActive();
    const job = this.tail.then(async () => {
      this.assertActive(); await this.heartbeat(); this.assertActive();
      const multipart = body instanceof FormData;
      const bodyCanvas = multipart ? body.get('canvasId') : body.canvasId;
      if (bodyCanvas && bodyCanvas !== this.canvasId) throw fail('WRONG_CANVAS', 'Body canvasId differs from session');
      if (path.startsWith('/canvas/') && !path.startsWith(`${this.path}/`) && path !== this.path) throw fail('WRONG_CANVAS', 'Path differs from session');
      let fields;
      if (multipart) {
        fields = new FormData();
        for (const [key, value] of body) fields.append(key, value);
        for (const [key, value] of Object.entries(this.proof)) fields.set(key, String(value));
        if (!fields.has('idempotencyKey')) fields.set('idempotencyKey', randomUUID());
      } else fields = { ...body, ...this.proof, idempotencyKey: body.idempotencyKey || randomUUID() };
      const request = this.client.request(method, path, fields, { timeoutMs });
      if (!providerRun) this.pending.add(request);
      let result;
      try { result = await request; }
      finally { this.pending.delete(request); }
      if (Number.isInteger(result?.resultRevision)) this.revision = result.resultRevision;
      else if (Number.isInteger(result?.revision)) this.revision = result.revision;
      if (result?.canvas) this.canvas = result.canvas;
      if (method === 'DELETE' && path === this.path) {
        // The canvas deletion also deletes its lease; there is nothing left to release.
        this.lease = null; this.state = 'draining'; clearTimeout(this.timer); this.abort.abort('Canvas deleted');
      }
      return result;
    });
    this.tail = job.catch(() => {});
    return job;
  }
  operations(operations, intent, idempotencyKey = randomUUID()) {
    return this.write('POST', `${this.path}/operations`, { operations, intent, idempotencyKey });
  }
  async uploadMedia(filename, kind, nodeId) {
    this.assertActive();
    const form = new FormData();
    form.set('file', new Blob([await readFile(filename)]), basename(filename));
    form.set('kind', kind); form.set('canvasId', this.canvasId);
    if (nodeId) form.set('nodeId', nodeId);
    return this.write('POST', '/comfyui/upload/media', form, { timeoutMs: 120000 });
  }
  async waitRun(runId, { timeoutMs = 900000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertActive();
      const run = await this.get(`/runs/${encodeURIComponent(runId)}`);
      if (!['queued', 'running'].includes(run.status)) return run;
      await Promise.race([sleep(intervalMs), this.done]);
    }
    throw fail('RUN_WAIT_TIMEOUT', 'Run remains on server; inspect history before retrying');
  }
  close(summary) {
    if (this.closing) return this.closing;
    this.state = 'draining'; this.abort.abort(summary); clearTimeout(this.timer);
    this.closing = (async () => {
      try {
        await this.beating?.catch(() => {});
        await Promise.allSettled([...this.pending]);
        if (!this.lease) return;
        // A synchronous provider request can continue after release. Do not wait for generation.
        // The newest Run provides a persistent handoff anchor; all other Runs remain queryable.
        try {
          await this.refresh();
          const history = await this.get(`/runs?canvasId=${encodeURIComponent(this.canvasId)}&pageSize=1`);
          if (history.items?.[0]) {
            await this.client.request('POST', `/runs/${encodeURIComponent(history.items[0].id)}/handoff`, { ...this.proof, summary });
            this.lease = null;
          }
        } catch (error) { this.handoffError = error.code || error.message; }
        if (this.lease) {
          try { await this.client.request('POST', `${this.path}/control/release`, this.proof, { timeoutMs: 5000 }); }
          catch (error) { if (!['LEASE_EXPIRED', 'STALE_LEASE'].includes(error.code)) throw error; }
          finally { this.lease = null; }
        }
      } finally { this.state = 'released'; this.resolveDone({ state: this.state, handoffError: this.handoffError }); }
    })();
    return this.closing;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const client = new CanvasClient();
  let result;
  if (command === 'get') result = await client.get(args[0]);
  else if (command === 'create') result = await client.request('POST', '/canvas', { name: args.join(' ') || 'New canvas' });
  else if (command === 'download') result = await client.download(args[0], args[1]);
  else if (command === 'run') {
    const task = await import(pathToFileURL(resolve(args[1])).href);
    result = await client.withCanvas(args[0], task.default, task.options || {});
  } else if (command === 'operations') {
    const body = JSON.parse((await readFile(args[1], 'utf8')).replace(/^\uFEFF/, ''));
    result = await client.withCanvas(args[0], s => s.operations(body.operations, body.intent, body.idempotencyKey));
  } else throw fail('USAGE', 'get /actions | create NAME | operations CANVAS_ID JSON_FILE | run CANVAS_ID TASK.mjs | download ASSET_ID DESTINATION');
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ code: error.code || 'CLIENT_ERROR', message: error.message })); process.exitCode = 1; });
}
