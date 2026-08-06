import { describe, expect, it } from 'vitest';
import { proxy } from 'svelte/internal/client';
import { snapshotReactiveState } from './reactive-snapshot.svelte.js';

describe('snapshotReactiveState', () => {
  it('detaches a real Svelte state proxy for structured editor mutations', () => {
    const reactivePolicy = proxy({
      runChargeQuotaByLane: { interactive: 100 },
      surfaceCosts: { model_call: 1 },
      optionalRationales: undefined,
    });

    expect(() => structuredClone(reactivePolicy)).toThrow();

    const snapshot = snapshotReactiveState(reactivePolicy);
    expect(snapshot).toEqual({
      runChargeQuotaByLane: { interactive: 100 },
      surfaceCosts: { model_call: 1 },
      optionalRationales: undefined,
    });
    expect(snapshot).not.toBe(reactivePolicy);
    expect(snapshot.runChargeQuotaByLane).not.toBe(reactivePolicy.runChargeQuotaByLane);

    snapshot.runChargeQuotaByLane.interactive = 25;
    expect(reactivePolicy.runChargeQuotaByLane.interactive).toBe(100);
  });
});
