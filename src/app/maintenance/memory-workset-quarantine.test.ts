import { describe, expect, it } from 'vitest';
import { parseMemoryWorksetQuarantineArgs } from './memory-workset-quarantine.js';

describe('memory workset quarantine CLI args (psfn-framework-d5e0p.3)', () => {
  it('defaults to episode synthesis and to a dry-run release', () => {
    expect(parseMemoryWorksetQuarantineArgs(['list']))
      .toMatchObject({ command: 'list', purpose: 'episodic_synthesis', apply: false });
    expect(parseMemoryWorksetQuarantineArgs(['release', '--session', 'api:a', '--session', 'api:b']))
      .toMatchObject({ command: 'release', sessionIds: ['api:a', 'api:b'], apply: false });
    expect(parseMemoryWorksetQuarantineArgs(['release', '--session', 'api:a', '--apply']).apply).toBe(true);
  });

  it('rejects unknown commands and purposes, release without a session, and list mutations', () => {
    expect(() => parseMemoryWorksetQuarantineArgs(['purge'])).toThrow(/list or release/);
    expect(() => parseMemoryWorksetQuarantineArgs(['list', '--purpose', 'dreams'])).toThrow(/--purpose must be one of/);
    expect(() => parseMemoryWorksetQuarantineArgs(['release'])).toThrow(/at least one --session/);
    expect(() => parseMemoryWorksetQuarantineArgs(['list', '--apply'])).toThrow(/only to release/);
  });
});
