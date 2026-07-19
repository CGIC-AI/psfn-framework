import { describe, expect, it } from 'vitest';
import { combineAbortSignal } from './abort-signal.js';

describe('combineAbortSignal', () => {
  it('returns the available signal without wrapping it', () => {
    const controller = new AbortController();

    expect(combineAbortSignal(controller.signal)).toBe(controller.signal);
    expect(combineAbortSignal(undefined, controller.signal)).toBe(controller.signal);
    expect(combineAbortSignal()).toBeUndefined();
  });

  it('aborts when either constituent signal aborts', () => {
    const primary = new AbortController();
    const secondary = new AbortController();
    const combined = combineAbortSignal(primary.signal, secondary.signal);

    expect(combined?.aborted).toBe(false);
    secondary.abort();
    expect(combined?.aborted).toBe(true);
  });
});
