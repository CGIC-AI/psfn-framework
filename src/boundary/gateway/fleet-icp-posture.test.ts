import { describe, expect, it, vi } from 'vitest';

import {
  deriveFleetIcpPosture,
  GatewayFleetIcpPostureSource,
  IcpPolicyOutcomeRecorder,
  projectFleetIcpCluster,
} from './fleet-icp-posture.js';
import {
  GatewayFleetPortalProjection,
  serializeFleetPortalProjection,
} from './fleet-portal-projection.js';
import type { IcpFleetHealthRead } from '../../persistence/postgres/icp-fleet-health-reader.js';
import type { GatewayFleetConnectionSnapshot } from './server.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const SESSION_TOKEN = 'S'.repeat(43);

type Connection = GatewayFleetConnectionSnapshot['connections'][number];

function connection(companionId: string, state: Connection['state'] = 'ready'): Connection {
  return {
    companionId: companionId as Connection['companionId'],
    state,
    health: 'healthy',
    stateReason: 'private-reason',
    connectedAt: NOW - 10_000,
    lastSeenAt: NOW - 1_000,
  };
}

function connections(
  live: Connection[],
  seen: readonly string[] = live.map(entry => entry.companionId),
): GatewayFleetConnectionSnapshot {
  return {
    generatedAt: NOW,
    connections: live,
    lastSeenByCompanionId: Object.fromEntries(seen.map(id => [id, NOW - 1_000])),
    recentViolationsByCompanionId: {},
    unattributedRecentViolationCount: 0,
    recentViolationWindowMs: 1,
  };
}

function health(overrides: Partial<IcpFleetHealthRead> = {}): IcpFleetHealthRead {
  return {
    availability: new Map([
      [A, { state: 'available', expiresAtMs: NOW + 60_000 }],
      [B, { state: 'resting', expiresAtMs: NOW + 60_000 }],
      [C, { state: 'available', expiresAtMs: NOW + 60_000 }],
    ]),
    lifecycleFenced: new Set(),
    openEpisodes: [
      { participantCompanionIds: [A, B] },
      { participantCompanionIds: [A, C] },
      { participantCompanionIds: [A, B, C] },
    ],
    openEpisodesTruncated: false,
    pairVolume: [
      { firstCompanionId: A, secondCompanionId: B, deliveredTurns: 7 },
      { firstCompanionId: A, secondCompanionId: C, deliveredTurns: 5 },
    ],
    ...overrides,
  };
}

const NO_FAILURES = { isFailing: () => false };

describe('fleet ICP posture derivation', () => {
  it('leaves a one-companion roster inert', () => {
    const snapshot = deriveFleetIcpPosture({
      fleetCompanionIds: [A],
      icpActive: false,
      health: 'unavailable',
      connections: connections([connection(A)]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(snapshot.cluster).toBe('inactive_singleton');
    expect(snapshot.companions.get(A)).toEqual({
      state: 'not_applicable', reason: 'singleton_fleet', lifecycle: 'member',
    });
    expect(projectFleetIcpCluster(snapshot, [A])).toEqual({
      state: 'inactive_singleton', activity: { status: 'not_applicable' },
    });
  });

  it('reports a ready cluster with coarse availability for every member', () => {
    const snapshot = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health(),
      connections: connections([connection(A), connection(B), connection(C)]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(snapshot.cluster).toBe('ready');
    expect(snapshot.companions.get(B)).toEqual({ state: 'ready', reason: 'resting', lifecycle: 'member' });
  });

  it('reports starting while agents register, then degraded once a seen agent drops', () => {
    const starting = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health(),
      connections: connections([connection(A), connection(B, 'registering')], [A]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(starting.cluster).toBe('starting');
    expect(starting.companions.get(B)).toMatchObject({ state: 'offline', reason: 'agent_starting' });
    expect(starting.companions.get(C)).toMatchObject({ state: 'offline', reason: 'agent_starting' });

    const degraded = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health(),
      connections: connections([connection(A), connection(B)], [A, B, C]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(degraded.cluster).toBe('degraded');
    expect(degraded.companions.get(C)).toEqual({
      state: 'offline', reason: 'agent_disconnected', lifecycle: 'member',
    });
    // Ready pairs remain usable while another member is unavailable.
    expect(degraded.companions.get(A)?.state).toBe('ready');
    expect(degraded.companions.get(B)?.state).toBe('ready');
    expect(projectFleetIcpCluster(degraded, [A, B, C]).activity).toMatchObject({ readyPairs: 1 });
  });

  it('resolves missing availability to explicit policy-unavailable reasons', () => {
    const failing = new IcpPolicyOutcomeRecorder(new Set([A, B, C]));
    failing.recordFailure(B, NOW - 5_000);
    failing.recordFailure(A, NOW - 20_000);
    const snapshot = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health({
        availability: new Map([
          [A, { state: 'available', expiresAtMs: NOW + 60_000 }],
          [B, { state: 'available', expiresAtMs: NOW + 60_000 }],
        ]),
      }),
      connections: connections([connection(A), connection(B), connection(C)]),
      policyOutcomes: failing,
      nowMs: NOW,
    });
    expect(snapshot.cluster).toBe('degraded');
    expect(snapshot.companions.get(B)).toEqual({
      state: 'policy_unavailable', reason: 'policy_authority_failed', lifecycle: 'member',
    });
    expect(snapshot.companions.get(C)).toEqual({
      state: 'policy_unavailable', reason: 'availability_withdrawn', lifecycle: 'member',
    });
    // A's failure predates its current connection (reconnect after restart).
    expect(snapshot.companions.get(A)).toEqual({ state: 'ready', reason: 'available', lifecycle: 'member' });

    const unreadable = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B],
      icpActive: true,
      health: 'unavailable',
      connections: connections([connection(A), connection(B)]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(unreadable.companions.get(A)).toMatchObject({ reason: 'coordination_state_unavailable' });
    expect(projectFleetIcpCluster(unreadable, [A, B])).toEqual({
      state: 'degraded', activity: { status: 'unavailable' },
    });
  });

  it('shows a fenced member as draining and excludes it from cluster membership', () => {
    const snapshot = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health({ lifecycleFenced: new Set([C]) }),
      connections: connections([connection(A), connection(B)], [A, B, C]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(snapshot.cluster).toBe('ready');
    expect(snapshot.companions.get(C)).toEqual({
      state: 'not_applicable', reason: 'lifecycle_draining', lifecycle: 'draining',
    });
    const pair = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B],
      icpActive: true,
      health: health({ lifecycleFenced: new Set([B]) }),
      connections: connections([connection(A), connection(B)]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(pair.cluster).toBe('inactive_singleton');
    expect(pair.companions.get(B)).toMatchObject({ reason: 'lifecycle_draining' });
  });

  it('counts only channels and volume whose members are all visible', () => {
    const snapshot = deriveFleetIcpPosture({
      fleetCompanionIds: [A, B, C],
      icpActive: true,
      health: health(),
      connections: connections([connection(A), connection(B), connection(C)]),
      policyOutcomes: NO_FAILURES,
      nowMs: NOW,
    });
    expect(projectFleetIcpCluster(snapshot, [A, B]).activity).toEqual({
      status: 'available',
      activeChannels: 1,
      activeChannelsTruncated: false,
      deliveredTurns24h: 7,
      readyPairs: 1,
    });
    expect(projectFleetIcpCluster(snapshot, [A]).activity).toMatchObject({
      activeChannels: 0, deliveredTurns24h: 0, readyPairs: 0,
    });
    expect(projectFleetIcpCluster(snapshot, [A, B, C]).activity).toMatchObject({
      activeChannels: 3, deliveredTurns24h: 12, readyPairs: 3,
    });
  });
});

describe('ICP policy outcome recorder', () => {
  it('clears a failure on later success and ignores companions outside the roster', async () => {
    const recorder = new IcpPolicyOutcomeRecorder(new Set([A]));
    await expect(recorder.observe(A, () => NOW, async () => {
      throw new Error('rpc down');
    })).rejects.toThrow('rpc down');
    expect(recorder.isFailing(A, NOW, NOW - 1)).toBe(true);
    expect(recorder.isFailing(A, NOW, NOW + 1)).toBe(false);
    await expect(recorder.observe(A, () => NOW + 1, async () => 'ok')).resolves.toBe('ok');
    expect(recorder.isFailing(A, NOW + 1, 0)).toBe(false);
    recorder.recordFailure(D, NOW);
    expect(recorder.isFailing(D, NOW, 0)).toBe(false);
  });
});

describe('gateway fleet ICP posture source', () => {
  it('coalesces concurrent reads and fails soft to coordination-unavailable', async () => {
    let release: (value: IcpFleetHealthRead) => void = () => undefined;
    const read = vi.fn(() => new Promise<IcpFleetHealthRead>((resolve) => { release = resolve; }));
    const source = new GatewayFleetIcpPostureSource({
      fleetCompanionIds: [B, A],
      icpActive: true,
      reader: { read, close: async () => undefined },
      policyOutcomes: NO_FAILURES,
      reportReadFailure: () => undefined,
    });
    const input = { nowMs: NOW, connections: connections([connection(A), connection(B)]) };
    const first = source.snapshot(input);
    const second = source.snapshot(input);
    release(health());
    await expect(first).resolves.toMatchObject({ cluster: 'ready' });
    await expect(second).resolves.toMatchObject({ cluster: 'ready' });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({
      companionIds: [A, B],
      nowMs: NOW,
      deliveredSinceMs: NOW - 24 * 60 * 60_000,
    });

    const reportReadFailure = vi.fn();
    const broken = new GatewayFleetIcpPostureSource({
      fleetCompanionIds: [A, B],
      icpActive: true,
      reader: { read: async () => { throw new Error('db down'); }, close: async () => undefined },
      policyOutcomes: NO_FAILURES,
      reportReadFailure,
    });
    await expect(broken.snapshot(input)).resolves.toMatchObject({ cluster: 'degraded', health: 'unavailable' });
    expect(reportReadFailure).toHaveBeenCalledOnce();
  });

  it('requires a shared reader whenever ICP is active', () => {
    expect(() => new GatewayFleetIcpPostureSource({
      fleetCompanionIds: [A, B],
      icpActive: true,
      policyOutcomes: NO_FAILURES,
      reportReadFailure: () => undefined,
    })).toThrow(/shared health reader/u);
  });

  it('serializes a maximal authorized fleet within the portal byte bound, deterministically', async () => {
    const ids = Array.from({ length: 256 }, (_, index) => (
      `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    ));
    const read: IcpFleetHealthRead = {
      availability: new Map(ids.map(id => [id, { state: 'do_not_disturb', expiresAtMs: NOW + 1 }])),
      lifecycleFenced: new Set(),
      openEpisodes: [],
      openEpisodesTruncated: true,
      pairVolume: [],
    };
    const build = () => new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [...ids].reverse().map(companionId => ({ companionId, gardenLinkEligible: true })),
        }),
      },
      // Worst case: longest label/avatar, timestamped posture, longest ICP reason.
      fleet: ids.map(companionId => ({
        companionId,
        displayName: 'N'.repeat(120),
        avatarRef: 'a'.repeat(512),
      })),
      source: {
        getFleetConnectionSnapshot: () => connections(ids.map(id => ({
          ...connection(id),
          posture: {
            schemaVersion: 1 as const,
            updatedAt: NOW - 1_000,
            charge: { state: 'exhausted' as const, utilizationPercent: 100 },
            fatigue: { state: 'exhausted' as const, utilizationPercent: 100 },
          },
        }))),
      },
      icpPosture: new GatewayFleetIcpPostureSource({
        fleetCompanionIds: ids,
        icpActive: true,
        reader: { read: async () => read, close: async () => undefined },
        policyOutcomes: { isFailing: () => true },
        reportReadFailure: () => undefined,
      }),
      now: () => new Date(NOW),
    });
    const first = serializeFleetPortalProjection(await build().resolve({ sessionToken: SESSION_TOKEN }));
    const text = () => first.toString('utf8');
    const second = serializeFleetPortalProjection(await build().resolve({ sessionToken: SESSION_TOKEN }));
    expect(first.equals(second)).toBe(true);
    expect(first.byteLength).toBeLessThanOrEqual(327_680);
    expect(text()).toContain('policy_authority_failed');
    for (const forbidden of ['private-reason', 'permit', 'candidate', 'trust', 'block', 'postgres']) {
      expect(text()).not.toContain(forbidden);
    }
  });
});
