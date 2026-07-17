import { describe, expect, it } from 'vitest';
import { isAdminConfirmationsData } from './queue-cache';

function confirmation(resolutionAuthority?: unknown): unknown {
  return {
    entries: [{
      id: 'confirmation-1',
      method: 'tools.call',
      action: 'write',
      scope: 'workspace',
      params: {},
      companionReason: 'Operator approval is required.',
      requestedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
      ...(resolutionAuthority === undefined ? {} : { resolutionAuthority }),
    }],
    available: true,
  };
}

describe('queue cache validators', () => {
  it('accepts only the canonical confirmation resolution authority', () => {
    expect(isAdminConfirmationsData(confirmation())).toBe(true);
    expect(isAdminConfirmationsData(confirmation('operator'))).toBe(true);
    expect(isAdminConfirmationsData(confirmation('companion'))).toBe(false);
    expect(isAdminConfirmationsData(confirmation({ kind: 'operator' }))).toBe(false);
    expect(isAdminConfirmationsData(confirmation(null))).toBe(false);
  });
});
