import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCompanionAttention,
  fleetAttentionBannerVisible,
  parseCompanionAttentionDigest,
  summarizeFleetAttention,
  type CompanionAttentionResult,
} from './attention-digest';
import type { FleetPortalCompanion } from './portal';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function digest(companionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    companionId,
    generatedAt: 1,
    incidents: { state: 'ok', open: [] },
    escalations: { state: 'ok', counts: { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 } },
    subsystems: { state: 'ok', attention: [] },
    deferredActions: { state: 'ok', failedCount: 0, permanentRejectCount: 0, retryScheduledCount: 0, recentFailures: [] },
    modelCalls: { state: 'ok', range: 'today', totalCalls: 10, failedCalls: 0, failuresByClassAndOrigin: [] },
    proactivity: { state: 'ok', outreach: null, feltImpulses: null },
    ...overrides,
  };
}

function companion(companionId: string, gardenPath?: string): FleetPortalCompanion {
  return {
    companionId,
    displayName: companionId.slice(-1),
    health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
    posture: { status: 'unavailable' },
    ...(gardenPath ? { gardenPath } : {}),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('parseCompanionAttentionDigest', () => {
  it('rejects a digest answered for another companion or with malformed sections', () => {
    expect(() => parseCompanionAttentionDigest(digest(B), A)).toThrow('different companion');
    expect(() => parseCompanionAttentionDigest(digest(A, { incidents: { state: 'weird' } }), A))
      .toThrow('section incidents is malformed');
    expect(parseCompanionAttentionDigest(digest(A), A).companionId).toBe(A);
  });
});

describe('summarizeFleetAttention', () => {
  it('aggregates across companions and never counts an unreachable Garden as clean', () => {
    const results: CompanionAttentionResult[] = [
      {
        companionId: A, displayName: 'a', state: 'ok',
        digest: parseCompanionAttentionDigest(digest(A, {
          incidents: { state: 'ok', open: [{ incidentId: 'i1' }, { incidentId: 'i2' }] },
          escalations: { state: 'ok', counts: { open: 1, acknowledged: 0, resolved: 0, dismissed: 0 } },
          deferredActions: { state: 'ok', failedCount: 3, permanentRejectCount: 0, retryScheduledCount: 0, recentFailures: [] },
          modelCalls: { state: 'ok', range: 'today', totalCalls: 10, failedCalls: 4, failuresByClassAndOrigin: [] },
        }), A),
      },
      { companionId: B, displayName: 'b', state: 'unreachable', reason: 'Garden answered HTTP 503' },
    ];
    const summary = summarizeFleetAttention(results);
    expect(summary).toEqual({
      companions: 2,
      unreachable: 1,
      openIncidents: 2,
      openEscalations: 1,
      attentionLanes: 0,
      exhaustedDeferredActions: 3,
      failedModelCalls: 4,
      companionsNeedingAttention: 1,
    });
    expect(fleetAttentionBannerVisible(summary)).toBe(true);
    expect(fleetAttentionBannerVisible(summarizeFleetAttention([results[1]!]))).toBe(false);
  });
});

describe('fetchCompanionAttention', () => {
  it('fetches the companion Garden digest and maps transport failures to unreachable', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.startsWith('/garden/a')
      ? new Response(JSON.stringify(digest(A)), { status: 200 })
      : new Response('{}', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCompanionAttention(companion(A, '/garden/a'))).resolves.toMatchObject({ state: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('/garden/a/api/admin/attention-digest', expect.objectContaining({ credentials: 'include' }));
    await expect(fetchCompanionAttention(companion(B, '/garden/b'))).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'Garden answered HTTP 503',
    });
    await expect(fetchCompanionAttention(companion(B))).resolves.toMatchObject({ state: 'unreachable' });
  });
});
