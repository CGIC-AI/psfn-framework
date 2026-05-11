import { describe, it, expect, beforeEach } from 'vitest';
import { ReflectionNudgeTracker } from './reflection-nudge.js';

describe('ReflectionNudgeTracker', () => {
  let tracker: ReflectionNudgeTracker;

  beforeEach(() => {
    tracker = new ReflectionNudgeTracker();
  });

  it('returns null for simple turns below tool threshold', () => {
    expect(tracker.evaluate({ toolCalls: 1, usedThinkTool: false })).toBeNull();
    expect(tracker.evaluate({ toolCalls: 2, usedThinkTool: false })).toBeNull();
  });

  it('does not nudge on first qualifying turn (default every 3rd)', () => {
    const result = tracker.evaluate({ toolCalls: 5, usedThinkTool: false });
    expect(result).toBeNull();
    expect(tracker.turnCount).toBe(1);
  });

  it('nudges on every Nth qualifying turn', () => {
    // Turn 1: qualifying but not Nth
    expect(tracker.evaluate({ toolCalls: 3, usedThinkTool: false })).toBeNull();
    // Turn 2: qualifying but not Nth
    expect(tracker.evaluate({ toolCalls: 4, usedThinkTool: false })).toBeNull();
    // Turn 3: qualifying AND Nth — should nudge
    const result = tracker.evaluate({ toolCalls: 3, usedThinkTool: false });
    expect(result).toContain('skill action="create"');
    expect(result).toContain('complex multi-step work');
  });

  it('qualifies turns with analysis workbench use regardless of tool count', () => {
    // Analysis workbench used but only 1 tool call.
    expect(tracker.evaluate({ toolCalls: 1, usedThinkTool: true })).toBeNull(); // 1st
    expect(tracker.evaluate({ toolCalls: 1, usedThinkTool: true })).toBeNull(); // 2nd
    const result = tracker.evaluate({ toolCalls: 1, usedThinkTool: true }); // 3rd
    expect(result).toContain('skill action="create"');
  });

  it('skips non-qualifying turns in count', () => {
    // Mix of qualifying and non-qualifying
    expect(tracker.evaluate({ toolCalls: 5, usedThinkTool: false })).toBeNull(); // qualifying: 1
    expect(tracker.evaluate({ toolCalls: 1, usedThinkTool: false })).toBeNull(); // non-qualifying
    expect(tracker.evaluate({ toolCalls: 4, usedThinkTool: false })).toBeNull(); // qualifying: 2
    expect(tracker.evaluate({ toolCalls: 0, usedThinkTool: false })).toBeNull(); // non-qualifying
    const result = tracker.evaluate({ toolCalls: 3, usedThinkTool: false }); // qualifying: 3
    expect(result).toContain('skill action="create"');
  });

  it('continues cycling after Nth turn', () => {
    // Get to the 3rd qualifying turn (nudge)
    tracker.evaluate({ toolCalls: 3, usedThinkTool: false });
    tracker.evaluate({ toolCalls: 3, usedThinkTool: false });
    expect(tracker.evaluate({ toolCalls: 3, usedThinkTool: false })).not.toBeNull();

    // Next cycle: 4th and 5th should not nudge, 6th should
    expect(tracker.evaluate({ toolCalls: 3, usedThinkTool: false })).toBeNull(); // 4
    expect(tracker.evaluate({ toolCalls: 3, usedThinkTool: false })).toBeNull(); // 5
    expect(tracker.evaluate({ toolCalls: 3, usedThinkTool: false })).not.toBeNull(); // 6
  });

  it('resets the counter', () => {
    tracker.evaluate({ toolCalls: 5, usedThinkTool: false });
    tracker.evaluate({ toolCalls: 5, usedThinkTool: false });
    expect(tracker.turnCount).toBe(2);

    tracker.reset();
    expect(tracker.turnCount).toBe(0);
  });

  it('respects custom config', () => {
    const custom = new ReflectionNudgeTracker({
      minToolCalls: 2,
      nudgeOnThinkTool: false,
      nudgeEveryNthTurn: 1,
    });

    // Every qualifying turn nudges (N=1)
    const result = custom.evaluate({ toolCalls: 2, usedThinkTool: false });
    expect(result).toContain('skill action="create"');
  });

  it('does not qualify analysis workbench use when nudgeOnThinkTool is false', () => {
    const custom = new ReflectionNudgeTracker({
      nudgeOnThinkTool: false,
      nudgeEveryNthTurn: 1,
    });

    // Analysis workbench used but below minToolCalls, so it should not qualify.
    const result = custom.evaluate({ toolCalls: 1, usedThinkTool: true });
    expect(result).toBeNull();
  });

  it('returns null for zero tool calls', () => {
    expect(tracker.evaluate({ toolCalls: 0, usedThinkTool: false })).toBeNull();
    expect(tracker.turnCount).toBe(0);
  });
});
