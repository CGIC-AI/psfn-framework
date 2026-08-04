import { describe, expect, it } from 'vitest';
import { classifySessionKind, type SessionKind } from './session-kind';

function session(sessionId: string, displayLabel?: string) {
  return { sessionId, channelId: sessionId, displayLabel };
}

describe('Canopy session kinds', () => {
  const cases: ReadonlyArray<readonly [string, SessionKind, string?]> = [
    ['discord:room-1', 'chat'],
    ['api:admin-user', 'chat'],
    ['model-room:garden:critic', 'chat'],
    ['subagent:research-1', 'subagent'],
    ['shard:worker-1', 'subagent'],
    ['internal:reflection:daily', 'scheduled'],
    ['reflection-journal:entry-1', 'scheduled'],
    ['system:intake-firewall', 'intake'],
    ['api:document', 'intake', 'Quarantined document intake'],
    ['unknown-session', 'other'],
  ];

  for (const [sessionId, expected, displayLabel] of cases) {
    it(`classifies ${sessionId} as ${expected}`, () => {
      expect(classifySessionKind(session(sessionId, displayLabel))).toBe(expected);
    });
  }
});
