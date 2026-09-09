import { SpeechToolRunnerService } from './speech-tool-runner.service';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

describe('SpeechToolRunnerService cleanup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports three failed cleanup attempts with observable process fields', async () => {
    jest.useFakeTimers();
    const service = new SpeechToolRunnerService();
    const child = { pid: 4321, exitCode: null, signalCode: null, kill: jest.fn(() => false) };
    (service as any).activeChild = child;
    const release = service.release();
    const assertion = expect(release).rejects.toMatchObject({ details: { code: 'PROVIDER_RELEASE_FAILED', provider: 'speech-evaluator', attempts: [
      expect.objectContaining({ attempt: 1, pid: 4321, ports: [], rssBytes: null, vramBytes: null }),
      expect.objectContaining({ attempt: 2, pid: 4321 }),
      expect.objectContaining({ attempt: 3, pid: 4321 }),
    ] } });
    await jest.runAllTimersAsync();
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('rejects preparation when stale worker state still names a live PID', async () => {
    const service = new SpeechToolRunnerService();
    const statePath = (service as any).workerState as string;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ pid: 4321, tool: 'funasr' }));
    jest.spyOn(process, 'kill').mockImplementation(() => true);
    try { await expect(service.prepare()).rejects.toMatchObject({ details: { code: 'PROVIDER_STATE_UNCONFIRMED', pid: 4321 } }); }
    finally { rmSync(statePath, { force: true }); }
  });
});
