import { describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('$lib/api/client', () => ({ apiGet: (path: string) => apiGet(path) }));

import {
  ATTENTION_SOURCES,
  mergeAttentionPollResults,
  shouldResetAttentionCounts,
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

  it('counts only open session_integrity incidents for the remediation badge (bead g59z)', async () => {
    const source = ATTENTION_SOURCES.find((s) => s.path === '/cognitive-security/remediation');
    expect(source).toBeDefined();

    apiGet.mockReset();
    apiGet.mockResolvedValueOnce({
      events: [
        { type: 'session_integrity', status: 'open' },
        { type: 'session_integrity', status: 'applied' },
        { type: 'content_poisoning', status: 'open' },
        { type: 'session_integrity', status: 'open' },
      ],
    });

    const count = await source!.fetchCount();
    expect(apiGet).toHaveBeenCalledWith('/api/admin/session-routes/cogsec/events');
    expect(count).toBe(2);
  });

  it('surfaces missed or failed journal runs on the global Journal navigation item', async () => {
    const source = ATTENTION_SOURCES.find((item) => item.path === '/values');
    expect(source).toBeDefined();

    apiGet.mockReset();
    apiGet.mockResolvedValueOnce({ attentionCount: 2 });

    await expect(source!.fetchCount()).resolves.toBe(2);
    expect(apiGet).toHaveBeenCalledWith('/api/admin/values/status');
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

  it('retains verified counts across inner-route navigation for the same companion', () => {
    expect(shouldResetAttentionCounts('companion-a', 'companion-a')).toBe(false);
  });

  it('clears counts only after an established companion or auth scope changes', () => {
    expect(shouldResetAttentionCounts(undefined, 'companion-a')).toBe(false);
    expect(shouldResetAttentionCounts('companion-a', 'companion-b')).toBe(true);
    expect(shouldResetAttentionCounts('companion-a', null)).toBe(true);
    expect(shouldResetAttentionCounts(null, 'companion-a')).toBe(true);
  });
});
