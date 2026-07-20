import { describe, expect, it, vi } from 'vitest';
import type { GatewayFleetConnectionSnapshot } from './server.js';
import {
  GatewayFleetPortalProjection,
  serializeFleetPortalProjection,
} from './fleet-portal-projection.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';
const COMPANION_D = '44444444-4444-4444-8444-444444444444';
const SESSION_TOKEN = 'S'.repeat(43);
const GENERATED_AT = new Date('2026-07-16T20:00:00.000Z');

function snapshot(
  connections: GatewayFleetConnectionSnapshot['connections'],
): GatewayFleetConnectionSnapshot {
  return {
    generatedAt: GENERATED_AT.getTime(),
    connections,
    lastSeenByCompanionId: {
      [COMPANION_B]: GENERATED_AT.getTime() - 1,
    },
    recentViolationsByCompanionId: {
      [COMPANION_C]: 99,
    },
    unattributedRecentViolationCount: 42,
    recentViolationWindowMs: 3_600_000,
  };
}

function connection(
  companionId: typeof COMPANION_A,
  state: 'registering' | 'ready' | 'degraded',
  health: 'healthy' | 'stale' | 'failed',
  posture?: GatewayFleetConnectionSnapshot['connections'][number]['posture'],
): GatewayFleetConnectionSnapshot['connections'][number] {
  return {
    companionId,
    state,
    health,
    stateReason: `private-${companionId}`,
    connectedAt: GENERATED_AT.getTime() - 10_000,
    lastSeenAt: GENERATED_AT.getTime() - 5_000,
    ...(posture ? { posture } : {}),
  };
}

describe('gateway fleet portal projection', () => {
  it('serializes only authorized manifest companions without topology or private authority fields', async () => {
    const authorize = vi.fn(async () => Object.freeze({
      companions: Object.freeze([
        Object.freeze({ companionId: COMPANION_A, gardenLinkEligible: true }),
      ]),
    }));
    const getFleetConnectionSnapshot = vi.fn(() => snapshot([
      connection(COMPANION_A, 'ready', 'healthy'),
      connection(COMPANION_B, 'degraded', 'failed'),
    ]));
    const projection = new GatewayFleetPortalProjection({
      authorizer: { resolve: authorize },
      fleet: [
        {
          companionId: COMPANION_A,
          gardenPort: 3211,
          label: 'private-a',
          postgresSchema: 'private_a',
        },
        {
          companionId: COMPANION_B,
          gardenPort: 3212,
          label: 'private-b',
          characterCardPath: '/private/b.json',
        },
        {
          companionId: COMPANION_C,
          label: 'private-c',
          companionDataDir: '/private/c',
        },
      ],
      source: { getFleetConnectionSnapshot },
      channelHealth: { healthOf: () => 'up' },
      now: () => GENERATED_AT,
    });

    const result = await projection.resolve({ sessionToken: SESSION_TOKEN });
    expect(result).toEqual({
      schemaVersion: 2,
      generatedAt: GENERATED_AT.toISOString(),
      session: { state: 'authenticated' },
      companions: [{
        companionId: COMPANION_A,
        displayName: COMPANION_A,
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
        posture: { status: 'unavailable' },
        gardenPath: `/companions/${COMPANION_A}/garden`,
      }],
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith({ sessionToken: SESSION_TOKEN });
    expect(getFleetConnectionSnapshot).toHaveBeenCalledOnce();
    const bytes = serializeFleetPortalProjection(result).toString('utf8');
    for (const forbidden of [
      COMPANION_B,
      COMPANION_C,
      'private-a',
      'private-b',
      'private-c',
      '3211',
      '3212',
      'private_a',
      '/private/b.json',
      '/private/c',
      'stateReason',
      'lastSeen',
      'violation',
      'principal',
      'provider',
      'contact',
      'role',
      'count',
    ]) {
      expect(bytes).not.toContain(forbidden);
    }
  });

  it('maps memory-only connection posture coarsely without exposing topology', async () => {
    const projection = new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [
            { companionId: COMPANION_A, gardenLinkEligible: true },
            { companionId: COMPANION_B, gardenLinkEligible: false },
            { companionId: COMPANION_C, gardenLinkEligible: false },
            { companionId: COMPANION_D, gardenLinkEligible: true },
          ],
        }),
      },
      fleet: [
        { companionId: COMPANION_A },
        { companionId: COMPANION_B },
        { companionId: COMPANION_C },
        { companionId: COMPANION_D },
      ],
      source: {
        getFleetConnectionSnapshot: () => snapshot([
          connection(COMPANION_A, 'ready', 'healthy'),
          connection(COMPANION_C, 'registering', 'healthy'),
          connection(COMPANION_D, 'degraded', 'stale'),
        ]),
      },
      now: () => GENERATED_AT,
    });

    await expect(projection.resolve({ sessionToken: SESSION_TOKEN })).resolves.toMatchObject({
      companions: [
        {
          companionId: COMPANION_A,
          health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'unknown' },
        },
        {
          companionId: COMPANION_D,
          health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'unknown' },
        },
      ],
    });
    const result = await projection.resolve({ sessionToken: SESSION_TOKEN });
    expect(result.companions).toHaveLength(2);
    expect(result.companions.every(companion => companion.gardenPath)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(COMPANION_B);
    expect(JSON.stringify(result)).not.toContain(COMPANION_C);
    expect(JSON.stringify(result)).not.toContain('gardenPort');
  });

  it('projects fresh and stale bounded posture without cross-attribution', async () => {
    const postureA = {
      schemaVersion: 1 as const,
      updatedAt: GENERATED_AT.getTime() - 1_000,
      charge: { state: 'pressured' as const, utilizationPercent: 25 },
      fatigue: { state: 'clear' as const, utilizationPercent: 0 },
    };
    const postureB = {
      schemaVersion: 1 as const,
      updatedAt: GENERATED_AT.getTime() - 90_001,
      charge: { state: 'exhausted' as const, utilizationPercent: 100 },
      fatigue: { state: 'pressured' as const, utilizationPercent: 67 },
    };
    const expiredPosture = {
      ...postureA,
      updatedAt: GENERATED_AT.getTime() - 180_001,
    };
    const projection = new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [
            { companionId: COMPANION_A, gardenLinkEligible: true },
            { companionId: COMPANION_B, gardenLinkEligible: true },
            { companionId: COMPANION_C, gardenLinkEligible: true },
          ],
        }),
      },
      fleet: [
        { companionId: COMPANION_A },
        { companionId: COMPANION_B },
        { companionId: COMPANION_C },
      ],
      source: {
        getFleetConnectionSnapshot: () => snapshot([
          connection(COMPANION_A, 'ready', 'healthy', postureA),
          connection(COMPANION_B, 'ready', 'healthy', postureB),
          connection(COMPANION_C, 'ready', 'healthy', expiredPosture),
        ]),
      },
      now: () => GENERATED_AT,
    });

    await expect(projection.resolve({ sessionToken: SESSION_TOKEN })).resolves.toMatchObject({
      companions: [
        {
          companionId: COMPANION_A,
          posture: {
            status: 'available',
            updatedAt: new Date(postureA.updatedAt).toISOString(),
            charge: { utilizationPercent: 25 },
            fatigue: { utilizationPercent: 0 },
          },
        },
        {
          companionId: COMPANION_B,
          posture: {
            status: 'stale',
            updatedAt: new Date(postureB.updatedAt).toISOString(),
            charge: { utilizationPercent: 100 },
            fatigue: { utilizationPercent: 67 },
          },
        },
        {
          companionId: COMPANION_C,
          posture: { status: 'unavailable' },
        },
      ],
    });
  });

  it('makes unknown and unauthorized manifest data byte-indistinguishable', async () => {
    const build = (unknownId: string) => new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [{ companionId: COMPANION_A, gardenLinkEligible: false }],
        }),
      },
      fleet: [
        { companionId: COMPANION_A },
        { companionId: unknownId },
      ],
      source: {
        getFleetConnectionSnapshot: () => snapshot([
          connection(COMPANION_A, 'ready', 'healthy'),
        ]),
      },
      now: () => GENERATED_AT,
    });
    const first = await build(COMPANION_B).resolve({ sessionToken: SESSION_TOKEN });
    const second = await build(COMPANION_C).resolve({ sessionToken: SESSION_TOKEN });
    expect(serializeFleetPortalProjection(first)).toEqual(serializeFleetPortalProjection(second));
  });

  it('fails closed on malformed inputs and colliding authority results', async () => {
    const projection = new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [
            { companionId: COMPANION_A, gardenLinkEligible: true },
            { companionId: COMPANION_A, gardenLinkEligible: false },
          ],
        }),
      },
      fleet: [{ companionId: COMPANION_A }],
      source: { getFleetConnectionSnapshot: () => snapshot([]) },
      now: () => GENERATED_AT,
    });

    await expect(projection.resolve({ sessionToken: SESSION_TOKEN, companionId: COMPANION_A }))
      .rejects.toMatchObject({ code: 'malformed_request' });
    await expect(projection.resolve({ sessionToken: SESSION_TOKEN }))
      .rejects.toThrow(/colliding/i);
  });

  describe('resolveRoster', () => {
    it('projects display identity + websocket path for authorized companions only', async () => {
      const authorize = vi.fn(async () => Object.freeze({
        companions: Object.freeze([
          Object.freeze({ companionId: COMPANION_B, gardenLinkEligible: true }),
          Object.freeze({ companionId: COMPANION_A, gardenLinkEligible: false }),
        ]),
      }));
      const projection = new GatewayFleetPortalProjection({
        authorizer: { resolve: authorize },
        fleet: [
          { companionId: COMPANION_A, gardenPort: 3211, displayName: 'Flagship' },
          { companionId: COMPANION_B, displayName: 'Aria', avatarRef: 'avatars/b.png' },
          { companionId: COMPANION_C, gardenPort: 3213, displayName: 'private-c' },
        ],
        source: { getFleetConnectionSnapshot: () => snapshot([]) },
        now: () => GENERATED_AT,
      });

      const roster = await projection.resolveRoster({ sessionToken: SESSION_TOKEN });
      expect(roster).toEqual({
        schemaVersion: 1,
        companions: [
          {
            companionId: COMPANION_A,
            displayName: 'Flagship',
            websocketPath: `/companion-ui/companions/${COMPANION_A}/ws`,
          },
          {
            companionId: COMPANION_B,
            displayName: 'Aria',
            websocketPath: `/companion-ui/companions/${COMPANION_B}/ws`,
            avatarRef: 'avatars/b.png',
          },
        ],
      });
      // COMPANION_C is in the manifest but not authorized: it never appears.
      expect(JSON.stringify(roster)).not.toContain(COMPANION_C);
      expect(JSON.stringify(roster)).not.toContain('private-c');
      expect(authorize).toHaveBeenCalledWith({ sessionToken: SESSION_TOKEN });
    });

    it('fails closed on a malformed request', async () => {
      const projection = new GatewayFleetPortalProjection({
        authorizer: { resolve: async () => ({ companions: [] }) },
        fleet: [{ companionId: COMPANION_A, gardenPort: 3211, displayName: 'Flagship' }],
        source: { getFleetConnectionSnapshot: () => snapshot([]) },
        now: () => GENERATED_AT,
      });
      await expect(projection.resolveRoster({ sessionToken: 'too-short' }))
        .rejects.toMatchObject({ code: 'malformed_request' });
    });

    it('fails closed when the authorizer returns an unknown or colliding companion', async () => {
      const unknownManifest = new GatewayFleetPortalProjection({
        authorizer: {
          resolve: async () => ({ companions: [{ companionId: COMPANION_D, gardenLinkEligible: true }] }),
        },
        fleet: [{ companionId: COMPANION_A, gardenPort: 3211, displayName: 'Flagship' }],
        source: { getFleetConnectionSnapshot: () => snapshot([]) },
        now: () => GENERATED_AT,
      });
      await expect(unknownManifest.resolveRoster({ sessionToken: SESSION_TOKEN }))
        .rejects.toThrow(/unknown manifest companion/i);

      const colliding = new GatewayFleetPortalProjection({
        authorizer: {
          resolve: async () => ({
            companions: [
              { companionId: COMPANION_A, gardenLinkEligible: true },
              { companionId: COMPANION_A, gardenLinkEligible: false },
            ],
          }),
        },
        fleet: [{ companionId: COMPANION_A, gardenPort: 3211, displayName: 'Flagship' }],
        source: { getFleetConnectionSnapshot: () => snapshot([]) },
        now: () => GENERATED_AT,
      });
      await expect(colliding.resolveRoster({ sessionToken: SESSION_TOKEN }))
        .rejects.toThrow(/colliding/i);
    });
  });
});
