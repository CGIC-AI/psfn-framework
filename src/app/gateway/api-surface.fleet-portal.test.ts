import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  createGatewayFleetPortalChannelHealthSource,
  createGatewayFleetPortalProjection,
} from './fleet-portal-composition.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const SESSION_TOKEN = 'S'.repeat(43);

function source() {
  return {
    getFleetConnectionSnapshot: vi.fn(() => ({
      generatedAt: 1,
      connections: [{
        companionId: COMPANION_ID,
        state: 'ready' as const,
        health: 'healthy' as const,
        stateReason: 'private',
        connectedAt: 1,
        lastSeenAt: 1,
      }],
      lastSeenByCompanionId: {},
      recentViolationsByCompanionId: {},
      unattributedRecentViolationCount: 0,
      recentViolationWindowMs: 1,
    })),
  };
}

describe('gateway API fleet portal composition', () => {
  it('keeps the projection absent when fleet authentication is disabled', () => {
    expect(createGatewayFleetPortalProjection({
      fleetAuthEnabled: false,
      source: source(),
    })).toBeUndefined();
  });

  it('fails startup closed when fleet auth lacks the batch authority or manifest', () => {
    expect(() => createGatewayFleetPortalProjection({
      fleetAuthEnabled: true,
      fleet: [{ companionId: COMPANION_ID }],
      source: source(),
    })).toThrow(/complete fleet portal projection wiring/u);
    expect(() => createGatewayFleetPortalProjection({
      fleetAuthEnabled: true,
      authorization: { resolve: async () => ({ companions: [] }) },
      source: source(),
    })).toThrow(/complete fleet portal projection wiring/u);
  });

  it('composes the persistence-backed batch authority with the gateway memory snapshot', async () => {
    const authorize = vi.fn(async () => ({
      companions: [{ companionId: COMPANION_ID, gardenLinkEligible: true }],
    }));
    const snapshot = source();
    const isConnected = vi.fn(() => true);
    const projection = createGatewayFleetPortalProjection({
      fleetAuthEnabled: true,
      authorization: { resolve: authorize },
      fleet: [{ companionId: COMPANION_ID }],
      source: snapshot,
      channelHealth: createGatewayFleetPortalChannelHealthSource([{
        companionId: COMPANION_ID,
        isConnected,
      }]),
    });

    await expect(projection?.resolve({ sessionToken: SESSION_TOKEN })).resolves.toMatchObject({
      session: { state: 'authenticated' },
      companions: [{
        companionId: COMPANION_ID,
        displayName: COMPANION_ID,
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
        gardenPath: `/companions/${COMPANION_ID}/garden`,
      }],
    });
    expect(authorize).toHaveBeenCalledWith({ sessionToken: SESSION_TOKEN });
    expect(snapshot.getFleetConnectionSnapshot).toHaveBeenCalledOnce();
    expect(isConnected).toHaveBeenCalledOnce();
  });

  it('reports channel health as unknown when no routed channel has a live signal', () => {
    const health = createGatewayFleetPortalChannelHealthSource([]);
    expect(health.healthOf(COMPANION_ID)).toBe('unknown');
  });

  it('does not report all channels down when one routed channel lacks a live signal', () => {
    const incomplete = createGatewayFleetPortalChannelHealthSource([
      { companionId: COMPANION_ID, isConnected: () => false },
      { companionId: COMPANION_ID, isConnected: () => undefined },
    ]);
    const complete = createGatewayFleetPortalChannelHealthSource([
      { companionId: COMPANION_ID, isConnected: () => false },
    ]);

    expect(incomplete.healthOf(COMPANION_ID)).toBe('unknown');
    expect(complete.healthOf(COMPANION_ID)).toBe('down');
  });
});
