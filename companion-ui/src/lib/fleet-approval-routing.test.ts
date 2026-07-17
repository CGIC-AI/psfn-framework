import { describe, expect, it, vi } from 'vitest';
import {
  hasPendingApprovalExpiry,
  mergeFleetApprovals,
  routeFleetApprovalDecision,
} from './fleet-approval-routing.js';
import type { FleetApprovalEntry } from './fleet-roster.js';
import {
  createInitialHubStreamState,
  reduceHubStreamState,
  type HubStreamState,
} from './stream/hub-stream.js';

const APPROVAL: FleetApprovalEntry = {
  companionId: '22222222-2222-4222-8222-222222222222',
  companionDisplayName: 'Artie',
  id: 'approval-1',
  title: 'Write file',
  redactedContext: 'Requested write',
  sourceSystem: 'tool-access',
  attribution: {
    parentId: '22222222-2222-4222-8222-222222222222',
    parentLabel: 'Artie',
  },
  action: 'write',
  scope: 'workspace',
  reason: 'Requested write',
  grantMode: { kind: 'once' },
  requestedAt: '2026-07-17T00:00:00.000Z',
  status: 'pending',
};

function readyState(): HubStreamState {
  return {
    ...createInitialHubStreamState(),
    session: {
      capabilities: { input: [], output: [], control: ['approvals'], safety: [] },
      eventCapabilities: ['approvals.v2'],
    },
  };
}

describe('routeFleetApprovalDecision', () => {
  it('never submits against the old connection when the owner switch fails', async () => {
    const submitApprovalDecision = vi.fn();
    const currentStore = vi.fn(() => ({
      snapshot: readyState,
      submitApprovalDecision,
    }));

    await expect(routeFleetApprovalDecision({
      id: APPROVAL.id,
      decision: 'approve',
      fleetApproval: APPROVAL,
      activeCompanionId: '11111111-1111-4111-8111-111111111111',
      switchCompanion: vi.fn(async () => false),
      currentStore,
    })).resolves.toBe(false);

    expect(currentStore).not.toHaveBeenCalled();
    expect(submitApprovalDecision).not.toHaveBeenCalled();
  });

  it('reads the current store only after a successful owner switch', async () => {
    const submitApprovalDecision = vi.fn();
    const currentStore = vi.fn(() => ({
      snapshot: readyState,
      submitApprovalDecision,
    }));

    await expect(routeFleetApprovalDecision({
      id: APPROVAL.id,
      decision: 'deny',
      fleetApproval: APPROVAL,
      activeCompanionId: '11111111-1111-4111-8111-111111111111',
      switchCompanion: vi.fn(async () => true),
      currentStore,
    })).resolves.toBe(true);

    expect(submitApprovalDecision).toHaveBeenCalledWith(APPROVAL.id, 'deny');
  });
});

describe('mergeFleetApprovals', () => {
  it('keeps fleet approvals hidden until approvals.v2 is acknowledged', () => {
    const panel = mergeFleetApprovals(
      createInitialHubStreamState('2026-07-17T00:00:00.000Z'),
      [APPROVAL],
      Date.parse('2026-07-17T00:00:01.000Z'),
    );

    expect(panel.capability).toBe('unsupported');
    expect(panel.requests).toEqual([]);
  });

  it('carries the complete fleet approval envelope into the card view', () => {
    const panel = mergeFleetApprovals(
      readyState(),
      [APPROVAL],
      Date.parse('2026-07-17T00:00:01.000Z'),
    );

    expect(panel.requests).toEqual([expect.objectContaining({
      id: APPROVAL.id,
      title: APPROVAL.title,
      sourceSystem: APPROVAL.sourceSystem,
      attribution: APPROVAL.attribution,
      action: APPROVAL.action,
      scope: APPROVAL.scope,
      reason: APPROVAL.reason,
      grantMode: APPROVAL.grantMode,
    })]);
  });

  it('applies a correlated server resolution to a fleet-only approval card', () => {
    const state = reduceHubStreamState(readyState(), {
      type: 'hub.inbound',
      at: '2026-07-17T00:00:02.000Z',
      event: {
        message: {
          type: 'approval.resolved',
          data: {
            id: APPROVAL.id,
            status: 'approved',
            resolvedAt: '2026-07-17T00:00:02.000Z',
          },
        },
      },
    });

    const panel = mergeFleetApprovals(
      state,
      [APPROVAL],
      Date.parse('2026-07-17T00:00:03.000Z'),
    );

    expect(panel.requests[0]).toMatchObject({
      id: APPROVAL.id,
      status: 'approved',
      resolvedAt: '2026-07-17T00:00:02.000Z',
    });
  });
});

describe('hasPendingApprovalExpiry', () => {
  it('starts the expiry clock for a fleet-only pending approval', () => {
    expect(hasPendingApprovalExpiry(
      readyState(),
      [{ ...APPROVAL, expiresAt: '2026-07-17T00:05:00.000Z' }],
    )).toBe(true);
  });
});
