import { describe, it, expect, vi } from 'vitest';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from './active-health-probe.js';

describe('CachedActiveHealthProbe', () => {
  it('returns successful probe result and reuses cached result during TTL', async () => {
    const probe = new CachedActiveHealthProbe({
      timeoutMs: 100,
      cacheTtlMs: 1_000,
    });
    const task = vi.fn(async () => {
      await Promise.resolve();
    });

    const first = await probe.run(task);
    const second = await probe.run(task);

    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('returns timeout reason when probe exceeds timeout budget', async () => {
    const timeoutMs = 25;
    const probe = new CachedActiveHealthProbe({
      timeoutMs,
      cacheTtlMs: 0,
    });

    const result = await probe.run(
      (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`timeout after ${timeoutMs}ms`);
    expect(result.cached).toBe(false);
  });

  it('returns upstream failure reason when probe throws', async () => {
    const probe = new CachedActiveHealthProbe({
      timeoutMs: 100,
      cacheTtlMs: 0,
    });

    const result = await probe.run(async () => {
      throw new Error('upstream unavailable');
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('upstream unavailable');
    expect(result.cached).toBe(false);
  });
});

describe('resolveActiveHealthProbeConfig', () => {
  it('defaults the active probe timeout to 10000ms', () => {
    const config = resolveActiveHealthProbeConfig({});

    expect(config).toEqual({
      enabled: true,
      timeoutMs: 10_000,
      cacheTtlMs: 10_000,
    });
  });

  it('parses enabled/timeout/cache ttl env overrides', () => {
    const config = resolveActiveHealthProbeConfig({
      API_HEALTH_ACTIVE_PROBES: 'false',
      API_HEALTH_PROBE_TIMEOUT_MS: '345',
      API_HEALTH_PROBE_CACHE_TTL_MS: '6789',
    });

    expect(config).toEqual({
      enabled: false,
      timeoutMs: 345,
      cacheTtlMs: 6789,
    });
  });

  it('includes active probe metadata fields', () => {
    const meta = toActiveProbeMeta(
      {
        enabled: true,
        timeoutMs: 100,
        cacheTtlMs: 200,
      },
      {
        ok: true,
        checkedAt: '2026-02-26T00:00:00.000Z',
        latencyMs: 17,
        cached: true,
      },
    );

    expect(meta).toMatchObject({
      probeMode: 'active',
      probeTimeoutMs: 100,
      probeCacheTtlMs: 200,
      probeCheckedAt: '2026-02-26T00:00:00.000Z',
      probeLatencyMs: 17,
      probeCached: true,
    });
  });
});
