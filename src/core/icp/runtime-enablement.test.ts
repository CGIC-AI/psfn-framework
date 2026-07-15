import { describe, expect, it } from 'vitest';

import { createIcpAutonomyRuntimeEnablement } from './runtime-enablement.js';

describe('ICP autonomy runtime enablement', () => {
  it('can only narrow startup authority', () => {
    const enabled = createIcpAutonomyRuntimeEnablement(true);
    expect(enabled.isEnabled()).toBe(true);
    enabled.disable();
    expect(enabled.isEnabled()).toBe(false);
    enabled.disable();
    expect(enabled.isEnabled()).toBe(false);
  });

  it('does not invent authority when startup disabled autonomy', () => {
    const disabled = createIcpAutonomyRuntimeEnablement(false);
    expect(disabled.isEnabled()).toBe(false);
  });
});
