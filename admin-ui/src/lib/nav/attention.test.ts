import { describe, expect, it, vi } from 'vitest';
import {
  mergeAttentionPollResults,
  updateAttentionCountsIfChanged,
} from './attention';

describe('attention count reconciliation', () => {
  it('skips the state write and retains the snapshot when counts are unchanged', () => {
    const current = {
      '/confirmations': 2,
      '/cognitive-security/approvals': 4,
    };
    const write = vi.fn();

    const reconciled = updateAttentionCountsIfChanged(current, {
      '/confirmations': 2,
      '/cognitive-security/approvals': 4,
    }, write);

    expect(reconciled).toBe(current);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes and returns the polled snapshot when any count changes', () => {
    const current = {
      '/confirmations': 2,
      '/cognitive-security/approvals': 4,
    };
    const polled = {
      '/confirmations': 2,
      '/cognitive-security/approvals': 5,
    };
    const write = vi.fn();

    const reconciled = updateAttentionCountsIfChanged(current, polled, write);

    expect(reconciled).toBe(polled);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(polled);
    expect(reconciled).toEqual({
      '/confirmations': 2,
      '/cognitive-security/approvals': 5,
    });
  });

  it('keeps the last count when a background source refresh fails', () => {
    const current = {
      '/confirmations': 2,
      '/cognitive-security/approvals': 4,
    };

    const polled = mergeAttentionPollResults(current, [
      { path: '/confirmations', count: 3 },
      { path: '/cognitive-security/approvals' },
    ]);

    expect(polled).toEqual({
      '/confirmations': 3,
      '/cognitive-security/approvals': 4,
    });
  });
});
