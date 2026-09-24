import { describe, expect, it } from 'vitest';
import {
  buildForeignSessionReadAuditEvent,
  opaqueSessionRef,
  parseForeignSessionReadReason,
} from './foreign-session-read-audit.js';

describe('foreign session read audit (ls15s)', () => {
  it('accepts only registered reason codes', () => {
    expect(parseForeignSessionReadReason(' reflection_group_conversation_scope '))
      .toBe('reflection_group_conversation_scope');
    expect(() => parseForeignSessionReadReason('')).toThrow(/non-empty/);
    expect(() => parseForeignSessionReadReason('reflection group conversation scope')).toThrow(/not a registered/);
  });

  it('builds a bounded event with stable opaque session refs', () => {
    const event = buildForeignSessionReadAuditEvent({
      reason: 'reflection_group_conversation_scope',
      sourceLogicalSessionId: 'internal:reflection:alpha',
      targetLogicalSessionId: 'discord:room-123',
      timestamp: 42,
    });
    expect(event).toEqual({
      reason: 'reflection_group_conversation_scope',
      sourceSessionRef: opaqueSessionRef('internal:reflection:alpha'),
      targetSessionRef: opaqueSessionRef('discord:room-123'),
      timestamp: 42,
    });
    expect(JSON.stringify(event)).not.toContain('room-123');
    expect(opaqueSessionRef('discord:room-123')).toBe(opaqueSessionRef('discord:room-123'));
  });
});
