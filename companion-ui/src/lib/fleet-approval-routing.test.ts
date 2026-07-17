import { describe, expect, it, vi } from 'vitest';
import { routeFleetApprovalDecision } from './fleet-approval-routing.js';
import type { FleetApprovalEntry } from './fleet-roster.js';
import { createInitialHubStreamState, type HubStreamState } from './stream/hub-stream.js';

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
