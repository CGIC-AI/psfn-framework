import { describe, expect, it } from 'vitest';
import {
  scanActorTerminologyEntries,
  shouldScanActorTerminologyFile,
} from './verify-actor-terminology.mjs';

describe('actor terminology verifier', () => {
  it('rejects relational uses of primary and HUD operator', () => {
    const result = scanActorTerminologyEntries([{
      path: 'docs/example.md',
      text: 'The primary user opens the HUD operator panel.',
    }]);

    expect(result.violations.map((entry) => entry.pattern)).toEqual([
      'primary-as-person',
      'hud-operator-as-partner',
    ]);
  });

  it('does not reject provider-wire or ordinary technical user vocabulary', () => {
    const result = scanActorTerminologyEntries([{
      path: 'docs/example.md',
      text: 'The provider role is `user`; the operating-system user is unprivileged.',
    }]);

    expect(result.violations).toEqual([]);
  });

  it('allows only exact legacy-input recognizers', () => {
    const result = scanActorTerminologyEntries([{
      path: 'src/persistence/repair/memory-participant-name-repair.ts',
      text: "  OR lower(text) LIKE '%primary user%'",
    }]);

    expect(result.violations).toEqual([]);
    expect(result.allowlisted).toHaveLength(1);
  });

  it('excludes tests and e2e fixtures from repository scanning', () => {
    expect(shouldScanActorTerminologyFile('src/core/example.test.ts')).toBe(false);
    expect(shouldScanActorTerminologyFile('src/app/e2e/example.ts')).toBe(false);
    expect(shouldScanActorTerminologyFile('src/core/example.ts')).toBe(true);
  });
});
