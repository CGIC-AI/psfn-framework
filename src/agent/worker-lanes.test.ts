import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_WORKER_LANE,
  SUBCONSCIOUS_WORKER_PROFILE_CLASS,
  TASK_FOCUSED_WORKER_PROFILE_CLASS,
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
  isSubagentWorkerLane,
  isWhisperWorkerLane,
  resolveWorkerProfileClassForLane,
} from './worker-lanes.js';

describe('worker lanes', () => {
  it('keeps task-focused subagents separate from the whisper metacognitive lane', () => {
    expect(SUBAGENT_WORKER_LANE).toBe('subagent');
    expect(WHISPER_WORKER_LANE).toBe('whisper');
    expect(isSubagentWorkerLane(SUBAGENT_WORKER_LANE)).toBe(true);
    expect(isSubagentWorkerLane(WHISPER_WORKER_LANE)).toBe(false);
    expect(isWhisperWorkerLane(WHISPER_WORKER_LANE)).toBe(true);
    expect(isWhisperWorkerLane(SUBAGENT_WORKER_LANE)).toBe(false);
  });

  it('maps worker lanes to explicit execution profiles and purpose slots', () => {
    expect(resolveWorkerProfileClassForLane(SUBAGENT_WORKER_LANE)).toBe(TASK_FOCUSED_WORKER_PROFILE_CLASS);
    expect(resolveWorkerProfileClassForLane(WHISPER_WORKER_LANE)).toBe(SUBCONSCIOUS_WORKER_PROFILE_CLASS);

    expect(createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE)).toEqual({
      lane: 'subagent',
      profileClass: 'task_focused',
      modelPurpose: 'background',
      failClosed: true,
    });
    expect(createWorkerExecutionPolicy(WHISPER_WORKER_LANE)).toEqual({
      lane: 'whisper',
      profileClass: 'subconscious',
      modelPurpose: 'memory',
      failClosed: true,
    });
  });
});
