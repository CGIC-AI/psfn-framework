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
  it('does not restore a previous Partner roster after authority is cleared', async () => {
    mocks.renewIfDue.mockResolvedValue(undefined);
    let finish!: (value: unknown) => void;
    mocks.readRoutingSnapshot.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const connect = vi.fn(async () => true);
    const { result } = renderHook(() => useFleetRouting({ accessState: 'signed_in', connect, reportError: vi.fn() }));
    let loading!: Promise<void>;
    await act(async () => {
      loading = result.current.load({
        schemaVersion: 1, state: 'signed_in', guestMode: 'disabled', websocketPath: WEBSOCKET_PATH,
        human: { provider: 'discord', label: 'Partner', role: 'owner' },
      }, 1, () => true, true);
      await Promise.resolve();
    });
    act(() => result.current.clear());
    await act(async () => {
      finish({
        roster: { schemaVersion: 1, companions: [{ companionId: COMPANION_ID, displayName: 'Canopy', websocketPath: WEBSOCKET_PATH }] },
        approvals: { schemaVersion: 1, approvals: [] },
      });
      await loading;
    });
    expect(result.current.roster).toEqual([]);
    expect(result.current.activeCompanionId).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not surface late polling errors after the Partner logs out', async () => {
    vi.useFakeTimers();
    mocks.renewIfDue.mockResolvedValue(undefined);
    let fail!: (reason: Error) => void;
    mocks.readApprovals.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const reportError = vi.fn();
    const { result, rerender } = renderHook(({ accessState }) => useFleetRouting({
      accessState, connect: async () => true, reportError,
    }), { initialProps: { accessState: 'signed_in' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.readApprovals).toHaveBeenCalledOnce();
    act(() => result.current.clear());
    rerender({ accessState: 'signed_out' });
    await act(async () => { fail(new Error('Old Partner approvals failed')); await Promise.resolve(); });
    expect(reportError).not.toHaveBeenCalled();
    expect(result.current.approvals).toEqual([]);
  });

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
