import { describe, expect, it, vi } from 'vitest';
import {
  APPROVALS_UNSUPPORTED_REASON,
  deriveApprovalPanelState,
  submitApprovalDecision,
  type ApprovalDecisionTransport,
} from './approvals.js';
import {
  createInitialHubStreamState,
  reduceHubStreamState,
  type HubStreamState,
} from './stream/hub-stream.js';

function ackedState(at = '2026-06-17T00:00:00.000Z'): HubStreamState {
  return reduceHubStreamState(createInitialHubStreamState(at), {
    type: 'hub.inbound',
    at,
    event: {
      message: {
        type: 'hello.ack',
        sessionId: 'session-1',
        channelId: 'channel-1',
        deviceId: 'device-1',
        deviceName: 'Device',
        satelliteId: 'satellite-1',
        satelliteName: 'Satellite',
        capabilities: {
          input: ['text'],
          output: ['text', 'artifact', 'tool_activity'],
          control: ['interrupt', 'presence', 'session_attach', 'approvals'],
          safety: ['confirmation_required'],
        },
      },
    },
  });
}

function withApprovalRequested(
  state: HubStreamState,
  data: { id: string; title: string; requestedAt: string; expiresAt?: string; redactedContext: string },
  at = '2026-06-17T00:00:01.000Z',
): HubStreamState {
  return reduceHubStreamState(state, {
    type: 'hub.inbound',
    at,
    event: { message: { type: 'approval.requested', data: { ...data, status: 'pending' } } },
  });
}

describe('approval panel fail-closed state', () => {
  it('reports unsupported when the hub has not acked the approvals capability', () => {
    expect(deriveApprovalPanelState(createInitialHubStreamState())).toEqual({
      capability: 'unsupported',
      requests: [],
      blockedReason: APPROVALS_UNSUPPORTED_REASON,
    });
  });

  it('stays unsupported even if an approval event somehow arrived without the capability ack', () => {
    const state = withApprovalRequested(createInitialHubStreamState(), {
      id: 'ap-1',
      title: 'Send outbound email',
      requestedAt: '2026-06-17T00:00:01.000Z',
      redactedContext: 'Redacted action summary',
    });

    expect(deriveApprovalPanelState(state).capability).toBe('unsupported');
  });

  it('becomes available and surfaces a pending request once the capability is acked', () => {
    const state = withApprovalRequested(ackedState(), {
      id: 'ap-1',
      title: 'Send outbound email',
      requestedAt: '2026-06-17T00:00:01.000Z',
      redactedContext: 'Redacted action summary',
    });

    const panel = deriveApprovalPanelState(state);
    expect(panel.capability).toBe('available');
    expect(panel.blockedReason).toBeNull();
    expect(panel.requests).toHaveLength(1);
    expect(panel.requests[0]).toMatchObject({ id: 'ap-1', status: 'pending' });
  });

  it('transitions a pending request to its resolved status', () => {
    let state = withApprovalRequested(ackedState(), {
      id: 'ap-1',
      title: 'Send outbound email',
      requestedAt: '2026-06-17T00:00:01.000Z',
      redactedContext: 'Redacted action summary',
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:05.000Z',
      event: {
        message: {
          type: 'approval.resolved',
          data: { id: 'ap-1', status: 'approved', resolvedAt: '2026-06-17T00:00:05.000Z' },
        },
      },
    });

    expect(deriveApprovalPanelState(state).requests[0]).toMatchObject({
      id: 'ap-1',
      status: 'approved',
      resolvedAt: '2026-06-17T00:00:05.000Z',
    });
  });

  it('ages a pending request out to expired past its expiresAt', () => {
    const state = withApprovalRequested(ackedState(), {
      id: 'ap-1',
      title: 'Send outbound email',
      requestedAt: '2026-06-17T00:00:01.000Z',
      expiresAt: '2026-06-17T00:00:30.000Z',
      redactedContext: 'Redacted action summary',
    });

    const before = deriveApprovalPanelState(state, Date.parse('2026-06-17T00:00:10.000Z'));
    expect(before.requests[0]).toMatchObject({ status: 'pending', expiresInSeconds: 20 });

    const after = deriveApprovalPanelState(state, Date.parse('2026-06-17T00:00:40.000Z'));
    expect(after.requests[0]).toMatchObject({ status: 'expired', expiresInSeconds: 0 });
  });
});

describe('approval decision submission', () => {
  it('blocks decisions when the capability is not acked', () => {
    const transport: ApprovalDecisionTransport = { submitApprovalDecision: vi.fn() };
    expect(() =>
      submitApprovalDecision(transport, createInitialHubStreamState(), 'ap-1', 'approve'),
    ).toThrow(APPROVALS_UNSUPPORTED_REASON);
    expect(transport.submitApprovalDecision).not.toHaveBeenCalled();
  });

  it('relays the decision through the transport when available', () => {
    const transport: ApprovalDecisionTransport = { submitApprovalDecision: vi.fn() };
    const state = withApprovalRequested(ackedState(), {
      id: 'ap-1',
      title: 'Send outbound email',
      requestedAt: '2026-06-17T00:00:01.000Z',
      redactedContext: 'Redacted action summary',
    });

    submitApprovalDecision(transport, state, 'ap-1', 'deny');

    expect(transport.submitApprovalDecision).toHaveBeenCalledWith('ap-1', 'deny');
  });
});
