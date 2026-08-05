import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFleetRouting } from './use-fleet-routing.js';

const mocks = vi.hoisted(() => ({
  readApprovals: vi.fn(),
  readRoutingSnapshot: vi.fn(),
  renewIfDue: vi.fn(),
}));

vi.mock('../lib/fleet-session.js', () => ({
  FleetSessionClient: class {
    renewIfDue = mocks.renewIfDue;
  },
}));

vi.mock('../lib/fleet-roster.js', () => ({
  FleetRosterClient: class {
    readApprovals = mocks.readApprovals;
    readRoutingSnapshot = mocks.readRoutingSnapshot;
  },
}));

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const WEBSOCKET_PATH = `/companion-ui/companions/${COMPANION_ID}/ws`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('fleet routing renewal recovery', () => {
  it('loads with the proven session and retries after a transient startup renewal failure', async () => {
    vi.useFakeTimers();
    const renewalFailure = new Error('Fleet session renewal was unavailable');
    mocks.renewIfDue.mockRejectedValueOnce(renewalFailure).mockResolvedValue(undefined);
    mocks.readRoutingSnapshot.mockResolvedValue({
      roster: {
        schemaVersion: 1,
        companions: [{
          companionId: COMPANION_ID,
          displayName: 'Canopy',
          websocketPath: WEBSOCKET_PATH,
        }],
      },
      approvals: { schemaVersion: 1, approvals: [] },
    });
    mocks.readApprovals.mockResolvedValue({ schemaVersion: 1, approvals: [] });
    const connect = vi.fn(async () => true);
    const reportError = vi.fn();
    const { result } = renderHook(() => useFleetRouting({
      accessState: 'signed_in',
      connect,
      reportError,
    }));

    await act(async () => {
      await result.current.load({
        schemaVersion: 1,
        state: 'signed_in',
        guestMode: 'disabled',
        websocketPath: WEBSOCKET_PATH,
        human: { provider: 'discord', label: 'Partner', role: 'owner' },
      }, 1, () => true, true);
    });

    expect(result.current.roster).toHaveLength(1);
    expect(connect).toHaveBeenCalledWith(WEBSOCKET_PATH, 1);
    expect(reportError).toHaveBeenCalledWith(renewalFailure.message);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.renewIfDue).toHaveBeenCalledTimes(2);
    expect(mocks.readApprovals).toHaveBeenCalledOnce();
  });
});
