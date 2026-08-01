import { describe, expect, it } from 'vitest';

import {
  scanActorTerminologyEntries,
  shouldScanActorTerminologyFile,
} from '../../../../scripts/actor-terminology-scan.mjs';

describe('actor terminology scan', () => {
  it('flags generic user language on a Partner-facing surface', () => {
    const result = scanActorTerminologyEntries([
      {
        path: 'companion-ui/src/ui/example.tsx',
        text: "export const greeting = 'Welcome back, user.';\n",
      },
    ]);

    expect(result.violations).toEqual([
      expect.objectContaining({
        file: 'companion-ui/src/ui/example.tsx',
        line: 1,
        pattern: 'generic-user',
        snippet: expect.stringContaining('user'),
      }),
    ]);
  });

  it('does not flag administrative Operator or technical primary language', () => {
    const result = scanActorTerminologyEntries([
      {
        path: 'src/boundary/fleet-auth/garden-route-authorization.ts',
        text: "throw new Error('Operator authorization is required for the primary route.');\n",
      },
    ]);

    expect(result.violations).toHaveLength(0);
  });

  it('flags relational Operator language without flagging administrative Operator language', () => {
    const result = scanActorTerminologyEntries([
      {
        path: 'src/core/identity/loader.ts',
        text: [
          "const relational = 'You are meeting the operator for the first time.';",
          "const administrative = 'Ask the Operator to inspect runtime diagnostics.';",
        ].join('\n'),
      },
    ]);

    expect(result.violations).toEqual([
      expect.objectContaining({ pattern: 'relational-operator' }),
    ]);
  });

  it('flags relational human euphemisms and permits generic human relationships', () => {
    const result = scanActorTerminologyEntries([
      {
        path: 'src/core/identity/prompt.ts',
        text: [
          "const retired = 'Take care of your human.';",
          'const account = <ReadOnlyAuthority label="Human" />;',
          "const generic = 'Do not withdraw from healthy human relationships.';",
        ].join('\n'),
      },
    ]);

    expect(result.violations).toEqual([
      expect.objectContaining({ pattern: 'relational-human' }),
      expect.objectContaining({ pattern: 'relational-human' }),
    ]);
  });

  it('flags exact retired relational phrases outside generic-user copy surfaces', () => {
    const result = scanActorTerminologyEntries([
      {
        path: 'src/channels/api/server/example.ts',
        text: [
          "const first = 'Ask your human partner.';",
          "const second = 'Your primary user is here.';",
          "const third = 'Open the HUD operator panel.';",
        ].join('\n'),
      },
    ]);

    expect(result.violations.map(violation => violation.pattern)).toEqual([
      'human-partner',
      'primary-as-partner',
      'hud-operator',
    ]);
  });

  it('accepts a narrow, noted baseline entry and reports stale entries', () => {
    const baseline = [
      {
        path: 'companion-ui/src/lib/protocol.ts',
        pattern: 'generic-user',
        contains: "label = 'user message'",
        note: 'The upstream chat protocol names this wire message role user.',
      },
      {
        path: 'docs/removed.md',
        pattern: 'generic-user',
        contains: 'Unix user account',
        note: 'Operating-system terminology.',
      },
    ];

    const result = scanActorTerminologyEntries(
      [{
        path: 'companion-ui/src/lib/protocol.ts',
        text: "export const label = 'user message';\n",
      }],
      { baseline },
    );

    expect(result.violations).toHaveLength(0);
    expect(result.baselined).toEqual([
      expect.objectContaining({ note: baseline[0]!.note }),
    ]);
    expect(result.staleBaseline).toEqual([baseline[1]]);
  });

  it('consumes each baseline entry once so duplicate violations still fail', () => {
    const result = scanActorTerminologyEntries(
      [{
        path: 'docs/protocol.md',
        text: 'The user prompt is a provider role.\nThe user prompt is a provider role.\n',
      }],
      {
        baseline: [{
          path: 'docs/protocol.md',
          pattern: 'generic-user',
          contains: 'The user prompt is a provider role.',
          note: 'One documented provider-role example.',
        }],
      },
    );

    expect(result.baselined).toHaveLength(1);
    expect(result.violations).toEqual([
      expect.objectContaining({ line: 2, pattern: 'generic-user' }),
    ]);
  });

  it('rejects malformed baseline entries instead of silently suppressing findings', () => {
    expect(() => scanActorTerminologyEntries(
      [{
        path: 'README.md',
        text: 'A user chats with the companion.\n',
      }],
      {
        baseline: [{
          path: 'README.md',
          pattern: 'generic-user',
          contains: 'user',
          note: '',
        }],
      },
    )).toThrow(/non-empty note/);
  });

  it('scans production copy surfaces and skips tests and private working docs', () => {
    expect(shouldScanActorTerminologyFile('README.md')).toBe(true);
    expect(shouldScanActorTerminologyFile('docs/architecture.md')).toBe(true);
    expect(shouldScanActorTerminologyFile('companion-ui/src/ui/App.tsx')).toBe(true);
    expect(shouldScanActorTerminologyFile('config/runtime-prompt-layers.seed.json')).toBe(true);
    expect(shouldScanActorTerminologyFile('scripts/ops/psfn-compose-smoke-seed.sh')).toBe(true);
    expect(shouldScanActorTerminologyFile('src/core/identity/prompt-registry.ts')).toBe(true);
    expect(shouldScanActorTerminologyFile('src/core/identity/prompt-registry.test.ts')).toBe(false);
    expect(shouldScanActorTerminologyFile('working_docs/briefs/lane.md')).toBe(false);
  });
});
