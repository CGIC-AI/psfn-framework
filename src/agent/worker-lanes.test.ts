import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_WORKER_LANE,
  WHISPER_WORKER_LANE,
  isSubagentWorkerLane,
  isWhisperWorkerLane,
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
});
