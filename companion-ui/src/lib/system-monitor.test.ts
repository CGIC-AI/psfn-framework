import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSystemMonitor, parseMonitorHealth } from './system-monitor.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const config = { companionId: A, freeTimeEnabled: false, socialDesireEnabled: false, weightedThoughtOutreachEnabled: true, emosimProactivityMode: 'on', proactive: { status: 'available', summary: { total: 1, states: [{ state: 'applied', count: 1, lastUpdatedAtMs: 10 }], lastFiredAtMs: 5, lastDeliveredAtMs: null } } };
const health = { generatedAt: 30, processStartedAt: 1, monitor: config, lanes: [{ id: 'free_time', label: 'Free time', status: 'failed', source: 'event_bus', sinceProcessStart: true, lastEventAt: 20, lastReason: 'idle:rested:chooser_timeout', lastError: 'PRIVATE ERROR BODY', counts: { turnsUsed: 0 }, recent: [{ at: 20, outcome: 'failed', reason: 'chooser_timeout' }] }] };
beforeEach(() => { vi.stubGlobal('navigator', { locks: { request: async (_name: string, _opts: unknown, callback: () => Promise<unknown>) => callback() } }); });
afterEach(() => vi.unstubAllGlobals());
describe('system monitor evidence boundary', () => {
  it('keeps disabled, failures and absent delivery explicit without carrying private bodies', () => {
    const result = parseMonitorHealth(health, A);
    expect(result.configuration?.freeTimeEnabled).toBe(false);
    expect(result.configuration?.proactive).toMatchObject({ summary: { lastDeliveredAtMs: null } });
    expect(result.lanes[0]).toMatchObject({ status: 'failed', lastSuccessAt: null, reason: 'idle:rested:chooser_timeout' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE ERROR BODY');
    expect(() => parseMonitorHealth(health, B)).toThrow('scope mismatch');
  });
  it('uses scoped same-origin authenticated requests and isolates independent source failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      expect(String(input)).toContain(`/companions/${A}/garden/api/admin/`);
      expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (String(input).includes('subsystem-health')) return new Response(JSON.stringify(health));
      if (String(input).includes('incidents')) return new Response('PRIVATE DENIAL', { status: 403 });
      return new Response(JSON.stringify({ recentEvents: [
        { attribution: { companionId: A }, telemetryVisibility: 'operator_visible', recordedAtMs: 22, provider: 'openrouter', model: 'example/model', status: 'success', metadata: { providerResponse: { servingProvider: 'Example host', responseId: 'gen-example' }, servingProvider: 'PRIVATE WRONG FLAT PROVIDER', content: 'PRIVATE MODEL BODY' } },
        { attribution: { companionId: B }, telemetryVisibility: 'operator_visible', provider: 'PRIVATE SIBLING PROVIDER' },
        { attribution: { companionId: A }, telemetryVisibility: 'companion_private', provider: 'PRIVATE MODEL PROVIDER' },
      ] }));
    });
    const result = await loadSystemMonitor(A, new AbortController().signal, fetcher);
    expect(result.health.status).toBe('available');
    expect(result.incidents.status).toBe('forbidden');
    expect(result.providers).toMatchObject({ status: 'available', data: [{ provider: 'openrouter', servingProvider: 'Example host' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('gen-example');
  });
  it.each([
    undefined,
    {},
    { providerResponse: null },
    { providerResponse: 'malformed' },
    { providerResponse: { servingProvider: 42 } },
    { providerResponse: { servingProvider: 'Conflicting host', conflicts: ['servingProvider'] } },
    { providerResponse: { servingProvider: '<private body>' } },
    { servingProvider: 'Unverified flat provider' },
  ])('keeps absent or malformed serving-provider metadata unknown: %j', async metadata => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      recentEvents: [{ attribution: { companionId: A }, telemetryVisibility: 'operator_visible',
        recordedAtMs: 22, provider: 'openrouter', model: 'example/model', status: 'success', metadata }],
    })));
    const result = await loadSystemMonitor(A, new AbortController().signal, fetcher);
    expect(result.providers).toEqual({ status: 'available', data: [{
      at: 22, provider: 'openrouter', model: 'example/model', status: 'success', servingProvider: null,
    }] });
  });
  it('retains a known serving provider when only its response ID conflicts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      recentEvents: [{ attribution: { companionId: A }, telemetryVisibility: 'operator_visible',
        recordedAtMs: 22, provider: 'openrouter', model: 'example/model', status: 'success',
        metadata: { providerResponse: { servingProvider: 'Known host', conflicts: ['responseId'] } } }],
    })));
    const result = await loadSystemMonitor(A, new AbortController().signal, fetcher);
    expect(result.providers).toMatchObject({ status: 'available', data: [{ servingProvider: 'Known host' }] });
  });
  it('fails closed on a mismatched incident owner and never falls back to another companion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ scope: { owner: { kind: 'companion', companionId: B } }, incidents: [] })));
    const result = await loadSystemMonitor(A, new AbortController().signal, fetcher);
    expect(result.incidents.status).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(loadSystemMonitor('invalid', new AbortController().signal, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
