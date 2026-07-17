import { describe, expect, it } from 'vitest';
import {
  inferSessionChannelType,
  isExperientialSelfDirectedSessionId,
  isInternalReflectionSessionId,
  isInternalSessionId,
} from './session-id.js';

describe('session-id helpers', () => {
  it('treats subagent channels as internal session ids', () => {
    expect(isInternalSessionId('subagent:task-1')).toBe(true);
    expect(inferSessionChannelType('subagent:task-1')).toBe('subagent');
  });

  it('identifies only reflection and free-time streams as experiential self-directed sessions', () => {
    expect(isExperientialSelfDirectedSessionId('internal:free-time:idle')).toBe(true);
    expect(isExperientialSelfDirectedSessionId('internal:free-time:quiet-hours')).toBe(true);
    expect(isExperientialSelfDirectedSessionId('internal:reflection:daily-review')).toBe(true);

    expect(isExperientialSelfDirectedSessionId('internal:heartbeat')).toBe(false);
    expect(isExperientialSelfDirectedSessionId('internal:maintenance')).toBe(false);
    expect(isExperientialSelfDirectedSessionId('subagent:task-1')).toBe(false);
    expect(isExperientialSelfDirectedSessionId('discord:dm:primary')).toBe(false);
  });

  it('identifies only internal reflection sessions for final-output provenance checks', () => {
    expect(isInternalReflectionSessionId('internal:reflection:daily-review')).toBe(true);
    expect(isInternalReflectionSessionId('internal:reflection:weekly-review')).toBe(true);
    expect(isInternalReflectionSessionId('internal:free-time:idle')).toBe(false);
    expect(isInternalReflectionSessionId('internal:heartbeat')).toBe(false);
  });
});
