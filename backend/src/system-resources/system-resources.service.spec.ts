import { cpuUsageBetween, parseNvidiaSmi } from './system-resources.service';

describe('SystemResourcesService helpers', () => {
  it('calculates total CPU usage from cumulative time deltas', () => {
    expect(cpuUsageBetween({ idle: 100, total: 400 }, { idle: 150, total: 600 })).toBe(75);
    expect(cpuUsageBetween({ idle: 100, total: 400 }, { idle: 100, total: 400 })).toBe(0);
  });

  it('parses multiple NVIDIA GPUs and tolerates unavailable values', () => {
    const devices = parseNvidiaSmi([
      '0, NVIDIA GeForce RTX 5060 Ti, 72, 63, 2048, 16384',
      '1, NVIDIA T4, N/A, 48, 512, 15360',
    ].join('\n'));
    expect(devices).toEqual([
      expect.objectContaining({ index: 0, name: 'NVIDIA GeForce RTX 5060 Ti', usagePercent: 72, temperatureC: 63, memoryUsedBytes: 2147483648 }),
      expect.objectContaining({ index: 1, name: 'NVIDIA T4', usagePercent: null, temperatureC: 48 }),
    ]);
  });

  it('ignores malformed GPU output', () => {
    expect(parseNvidiaSmi('driver error\n')).toEqual([]);
  });
});
