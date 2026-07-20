import { describe, expect, it } from 'vitest';
import {
  inferSessionChannelType,
  isExperientialSelfDirectedSessionId,
  isInternalReflectionSessionId,
  isInternalSessionId,
  isTestingSessionId,
  TESTING_SESSION_NAMESPACE,
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

describe('testing session ids', () => {
  it('recognizes the reserved namespace after the channel prefix', () => {
    expect(TESTING_SESSION_NAMESPACE).toBe('testing');
    expect(isTestingSessionId('api:testing:kube-rollout-validation-20260719')).toBe(true);
    expect(isTestingSessionId('api:rollout-validator:testing:kube-rollout-validation-20260719')).toBe(true);
    expect(isTestingSessionId('discord:testing:voice-roundtrip-42')).toBe(true);
    expect(isTestingSessionId('internal:testing:maintenance-probe')).toBe(true);
  });

  it('composes with channel-type inference', () => {
    expect(inferSessionChannelType('api:testing:kube-rollout-validation-20260719')).toBe('api');
    expect(inferSessionChannelType('discord:testing:voice-roundtrip-42')).toBe('discord');
  });

  it('rejects incidental, misplaced, and empty markers', () => {
    expect(isTestingSessionId('api:kube-rollout-testing-validation')).toBe(false);
    expect(isTestingSessionId('testing:api:probe')).toBe(false);
    expect(isTestingSessionId('api:testing:')).toBe(false);
    expect(isTestingSessionId('api:TESTING:probe')).toBe(false);
    expect(isTestingSessionId('api:contest:probe')).toBe(false);
  });
});
