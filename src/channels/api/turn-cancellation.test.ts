import { describe, expect, it, vi } from 'vitest';
import { QueuedApiTurnCancellation } from './turn-cancellation.js';

describe('QueuedApiTurnCancellation', () => {
  it('uses the resolved channel when an admitted turn is cancelled', () => {
    const abortActiveTurn = vi.fn(() => ({ status: 'signaled' as const }));
    const cancellation = new QueuedApiTurnCancellation('api:synthetic', abortActiveTurn);

    cancellation.setChannelId('companion-ui:resolved');
    cancellation.markActive();

    expect(cancellation.cancel('client_disconnected')).toEqual({ status: 'signaled' });
    expect(cancellation.channelId).toBe('companion-ui:resolved');
    expect(abortActiveTurn).toHaveBeenCalledWith('companion-ui:resolved');
  });

  it('keeps the first reason and signals a queued cancellation only once', () => {
    const abortActiveTurn = vi.fn(() => ({ status: 'signaled' as const }));
    const cancellation = new QueuedApiTurnCancellation('api:queued', abortActiveTurn);

    expect(cancellation.cancel('client_disconnected')).toEqual({ status: 'signaled' });
    expect(cancellation.cancel('timeout')).toEqual({ status: 'already_aborted' });
    expect(cancellation.claimTimeout()).toBe(false);
    expect(cancellation.cancellationReason).toBe('client_disconnected');
    expect(abortActiveTurn).not.toHaveBeenCalled();
  });
});
