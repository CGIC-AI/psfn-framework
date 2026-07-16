import { describe, expect, it } from 'vitest';

import {
  buildSubsystemOutputRef,
  buildTurnSubsystemProjectionRef,
  parseSubsystemOutputRef,
  parseTurnSubsystemProjectionRef,
} from './subsystem-output-refs.js';

describe('subsystem output refs', () => {
  it.each(['memory', 'concern', 'contact'] as const)(
    'round-trips a canonical %s target without exposing delimiter ambiguity',
    (kind) => {
      const ref = buildSubsystemOutputRef(kind, 'opaque:id/with spaces');

      expect(ref).toMatch(new RegExp(`^loom-output:v1:${kind}:[A-Za-z0-9_-]+$`));
      expect(parseSubsystemOutputRef(ref)).toEqual({
        schemaVersion: 1,
        kind,
        targetId: 'opaque:id/with spaces',
      });
    },
  );

  it.each([
    '',
    'memory-1',
    'loom-output:v2:memory:bWVtb3J5LTE',
    'loom-output:v1:unknown:bWVtb3J5LTE',
    'loom-output:v1:memory:',
    'loom-output:v1:memory:not+base64',
    'loom-output:v1:memory:bWVtb3J5LTE=',
    'loom-output:v1:memory:IA',
  ])('rejects malformed or non-canonical refs: %s', (ref) => {
    expect(() => parseSubsystemOutputRef(ref)).toThrow('Invalid Loom subsystem output ref');
  });

  it('rejects blank target identifiers before persistence', () => {
    expect(() => buildSubsystemOutputRef('memory', '  ')).toThrow(
      'Subsystem output targetId must be a non-empty string',
    );
  });

  it('binds a projection handle to the exact source turn without target data', () => {
    const binding = {
      logicalSessionId: 'logical:session',
      sourceChannelId: 'discord:room',
      sourceTurnId: 'turn-1',
      sourceRequestId: 'request-1',
    };
    const ref = buildTurnSubsystemProjectionRef('memory', binding);

    expect(ref).toMatch(/^loom-projection:v1:memory:[a-f0-9]{64}$/u);
    expect(ref).not.toContain(binding.logicalSessionId);
    expect(parseTurnSubsystemProjectionRef(ref, binding, 'memory')).toEqual({
      schemaVersion: 1,
      kind: 'memory',
      bindingSha256: ref.slice(ref.lastIndexOf(':') + 1),
    });
    expect(() => parseTurnSubsystemProjectionRef(ref, {
      ...binding,
      sourceRequestId: 'request-2',
    }, 'memory')).toThrow('Invalid Loom subsystem projection ref');
    expect(() => parseTurnSubsystemProjectionRef(ref, binding, 'contact')).toThrow(
      'Invalid Loom subsystem projection ref',
    );
  });
});
