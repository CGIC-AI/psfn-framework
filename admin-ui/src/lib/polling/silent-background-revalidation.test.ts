import { describe, expect, it, vi } from 'vitest';
import {
  createSilentBackgroundRevalidation,
  reconcilePollingSnapshot,
} from './silent-background-revalidation';

describe('silent Garden background revalidation', () => {
  it('retains the complete snapshot identity when repeated poll payloads are unchanged', () => {
    const current = {
      entries: [{ id: 'held-1', count: 2, labels: ['review'] }],
      available: true,
    };

    const first = reconcilePollingSnapshot(current, structuredClone(current));
    const second = reconcilePollingSnapshot(first, structuredClone(current));

    expect(first).toBe(current);
    expect(second).toBe(current);
    expect(second.entries).toBe(current.entries);
    expect(second.entries[0]).toBe(current.entries[0]);
  });

  it('replaces only a changed row while retaining stable keyed row identities', () => {
    const first = { id: 'held-1', count: 2 };
    const second = { id: 'held-2', count: 1 };
    const current = { entries: [first, second] };

    const next = reconcilePollingSnapshot(current, {
      entries: [
        { id: 'held-1', count: 3 },
        { id: 'held-2', count: 1 },
      ],
    });

    expect(next).not.toBe(current);
    expect(next.entries).not.toBe(current.entries);
    expect(next.entries[0]).not.toBe(first);
    expect(next.entries[1]).toBe(second);
  });

  it('retains keyed row identities across insertion and reordering', () => {
    const first = { id: 'held-1', count: 2 };
    const second = { id: 'held-2', count: 1 };
    const current = [first, second];

    const next = reconcilePollingSnapshot(current, [
      { id: 'held-3', count: 1 },
      { id: 'held-2', count: 1 },
      { id: 'held-1', count: 2 },
    ]);

    expect(next[0]).toEqual({ id: 'held-3', count: 1 });
    expect(next[1]).toBe(second);
    expect(next[2]).toBe(first);
  });

  it('retains fleet companion identities across insertion and reordering', () => {
    const first = { companionId: 'companion-1', displayName: 'One' };
    const second = { companionId: 'companion-2', displayName: 'Two' };
    const current = [first, second];

    const next = reconcilePollingSnapshot(current, [
      { companionId: 'companion-3', displayName: 'Three' },
      { companionId: 'companion-2', displayName: 'Two' },
      { companionId: 'companion-1', displayName: 'One' },
    ]);

    expect(next[1]).toBe(second);
    expect(next[2]).toBe(first);
  });

  it('surfaces refresh errors locally and discards a superseded response', async () => {
    let current = { entries: [{ id: 'held-1', count: 1 }] };
    let resolveFirst: ((value: { entries: Array<{ id: string; count: number }> }) => void) | undefined;
    const responses = [
      new Promise<typeof current>(resolve => { resolveFirst = resolve; }),
      Promise.resolve({ entries: [{ id: 'held-1', count: 2 }] }),
    ];
    const reportError = vi.fn();
    const write = vi.fn((next: typeof current) => { current = next; });
    const revalidation = createSilentBackgroundRevalidation({
      load: async publish => publish(await responses.shift()!),
      read: () => current,
      write,
      reportError,
      fallbackError: 'Refresh failed',
    });

    const stale = revalidation.refresh();
    const currentRequest = revalidation.refresh();
    await currentRequest;
    resolveFirst?.({ entries: [{ id: 'held-1', count: 9 }] });
    await stale;

    expect(current.entries[0]?.count).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenLastCalledWith('');

    const failed = createSilentBackgroundRevalidation({
      load: async () => { throw new Error('Queue temporarily unavailable'); },
      read: () => current,
      write,
      reportError,
      fallbackError: 'Refresh failed',
    });
    await failed.refresh();
    expect(reportError).toHaveBeenLastCalledWith('Queue temporarily unavailable');
    expect(current.entries[0]?.count).toBe(2);
  });
});
