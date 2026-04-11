import { describe, expect, it } from 'vitest';
import { inferSessionChannelType, isInternalSessionId } from './session-id.js';

describe('session-id helpers', () => {
  it('treats subagent channels as internal session ids', () => {
    expect(isInternalSessionId('subagent:task-1')).toBe(true);
    expect(inferSessionChannelType('subagent:task-1')).toBe('subagent');
  });
});
