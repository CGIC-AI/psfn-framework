import { describe, it, expect, beforeEach } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { createEmptyToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import { ReflectionNudgeTracker, type TurnToolSummary } from './reflection-nudge.js';
import type { SkillEntry } from './types.js';

function ownedSkill(overrides: Partial<SkillEntry>): SkillEntry {
  return fromAny({
    id: `custom:${overrides.name ?? 'skill'}`,
    name: 'skill',
    description: '',
    source: 'custom',
    version: 1,
    always: false,
    precedence: 0,
    ...overrides,
  });
}

const CLEAN_TURN = { ...createEmptyToolCallOutcomeCounts(), success: 3 };

function complexTurn(overrides: Partial<TurnToolSummary> = {}): TurnToolSummary {
  return {
    toolCalls: 3,
    usedThinkTool: false,
    outcomes: CLEAN_TURN,
    ...overrides,
  };
}

describe('ReflectionNudgeTracker', () => {
  let tracker: ReflectionNudgeTracker;

  beforeEach(() => {
    tracker = new ReflectionNudgeTracker();
  });

  it('returns null for simple turns below tool threshold', () => {
    expect(tracker.evaluate(complexTurn({ toolCalls: 1 }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 2 }))).toBeNull();
  });

  it('does not nudge on first qualifying turn (default every 3rd)', () => {
    expect(tracker.evaluate(complexTurn({ toolCalls: 5 }))).toBeNull();
    expect(tracker.turnCount).toBe(1);
  });

  it('offers a create only on every Nth qualifying turn', () => {
    expect(tracker.evaluate(complexTurn())).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 4 }))).toBeNull();
    const result = tracker.evaluate(complexTurn());
    expect(result).toContain('skill action="create"');
    expect(result).toContain('no owned skill covers it');
  });

  it('qualifies turns with analysis workbench use regardless of tool count', () => {
    expect(tracker.evaluate(complexTurn({ toolCalls: 1, usedThinkTool: true }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 1, usedThinkTool: true }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 1, usedThinkTool: true })))
      .toContain('skill action="create"');
  });

  it('skips non-qualifying turns in count', () => {
    expect(tracker.evaluate(complexTurn({ toolCalls: 5 }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 1 }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 4 }))).toBeNull();
    expect(tracker.evaluate(complexTurn({ toolCalls: 0 }))).toBeNull();
    expect(tracker.evaluate(complexTurn())).toContain('skill action="create"');
  });

  it('resets the counter', () => {
    tracker.evaluate(complexTurn({ toolCalls: 5 }));
    tracker.evaluate(complexTurn({ toolCalls: 5 }));
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
    expect(custom.evaluate(complexTurn({ toolCalls: 2 }))).toContain('skill action="create"');
  });

  it('does not qualify analysis workbench use when nudgeOnThinkTool is false', () => {
    const custom = new ReflectionNudgeTracker({
      nudgeOnThinkTool: false,
      nudgeEveryNthTurn: 1,
    });
    expect(custom.evaluate(complexTurn({ toolCalls: 1, usedThinkTool: true }))).toBeNull();
  });

  it('returns null for zero tool calls', () => {
    expect(tracker.evaluate(complexTurn({ toolCalls: 0 }))).toBeNull();
    expect(tracker.turnCount).toBe(0);
  });
});

// psfn-framework-lpxg3.3: reuse before creation, and only from evidence that
// actually supports promotion.
describe('ReflectionNudgeTracker reuse loop', () => {
  function trackerWith(entries: SkillEntry[]): ReflectionNudgeTracker {
    return new ReflectionNudgeTracker({
      config: { nudgeEveryNthTurn: 1 },
      resolveAdmittedSkills: () => entries,
    });
  }

  const RELEASE_SKILL = ownedSkill({
    name: 'release-checklist',
    description: 'Steps for cutting and verifying a release build.',
    category: 'delivery',
    version: 4,
  });

  it('prefers revising a relevant owned skill over creating a duplicate', () => {
    const result = trackerWith([RELEASE_SKILL]).evaluate(complexTurn({
      taskCue: 'walk through the release checklist and verify the release build',
    }));
    expect(result).toContain('skill action="update"');
    expect(result).toContain('release-checklist');
    expect(result).toContain('base_version=4');
    expect(result).not.toContain('action="create"');
  });

  it('offers a create when no owned skill is relevant to the cue', () => {
    const result = trackerWith([RELEASE_SKILL]).evaluate(complexTurn({
      taskCue: 'reconcile the quarterly invoicing spreadsheet with the ledger',
    }));
    expect(result).toContain('skill action="create"');
  });

  it('never surfaces a skill the companion does not own', () => {
    const bundled = ownedSkill({
      name: 'release-checklist',
      description: 'Steps for cutting and verifying a release build.',
      source: 'bundled',
    });
    const result = trackerWith([bundled]).evaluate(complexTurn({
      taskCue: 'walk through the release checklist and verify the release build',
    }));
    expect(result).toContain('skill action="create"');
    expect(result).not.toContain('release-checklist');
  });

  it('promotes nothing from a failed, denied, or degraded turn', () => {
    for (const degraded of [
      { execution_failure: 1 },
      { policy_denial: 1 },
      { validation_rejection: 1 },
      { content_withheld: 1 },
      { screening_unavailable: 1 },
      { partial_result: 1 },
    ]) {
      const tracker = trackerWith([RELEASE_SKILL]);
      expect(tracker.evaluate(complexTurn({
        taskCue: 'walk through the release checklist',
        outcomes: { ...createEmptyToolCallOutcomeCounts(), success: 2, ...degraded },
      }))).toBeNull();
    }
  });

  it('treats an unobserved outcome census as no evidence at all', () => {
    const tracker = trackerWith([RELEASE_SKILL]);
    expect(tracker.evaluate({ toolCalls: 5, usedThinkTool: false })).toBeNull();
  });

  it('records post-use outcome evidence for every observed turn and ranks with it (sap72)', () => {
    const recorded: boolean[] = [];
    const alpha = ownedSkill({
      name: 'release-alpha',
      description: 'Steps for cutting and verifying a release build.',
    });
    const beta = ownedSkill({
      name: 'release-beta',
      description: 'Steps for cutting and verifying a release build.',
    });
    const evidenceTracker = new ReflectionNudgeTracker({
      config: { nudgeEveryNthTurn: 1 },
      resolveAdmittedSkills: () => [alpha, beta],
      resolveOutcomeEvidence: () => new Map([['release-beta', {
        name: 'release-beta',
        demonstratedCount: 5,
        ambiguousCount: 0,
        lastOutcomeAt: null,
      }]]),
      recordPostUseOutcome: ({ demonstratedValue }) => { recorded.push(demonstratedValue); },
    });

    // A degraded turn raises no opportunity but its outcome is still recorded:
    // evidence is not gated on the quietness budget.
    expect(evidenceTracker.evaluate(complexTurn({
      taskCue: 'cut and verify the release build',
      outcomes: { ...createEmptyToolCallOutcomeCounts(), success: 1, partial_result: 1 },
    }))).toBeNull();
    expect(recorded).toEqual([false]);

    // A clean turn records success and ranks the skill whose past uses worked
    // out ahead of the equally relevant one with no history.
    expect(evidenceTracker.evaluate(complexTurn({
      taskCue: 'cut and verify the release build',
    }))).toContain('release-beta');
    expect(recorded).toEqual([false, true]);

    // A turn whose census was never observed records nothing at all.
    expect(evidenceTracker.evaluate({ toolCalls: 5, usedThinkTool: false })).toBeNull();
    expect(recorded).toEqual([false, true]);

    // A SIMPLE turn raises no opportunity but still answers for the skills it
    // used: attribution must not slide onto the next complex turn.
    expect(evidenceTracker.evaluate(complexTurn({ toolCalls: 1 }))).toBeNull();
    expect(recorded).toEqual([false, true, true]);
  });

  it('never lets a telemetry failure reach the turn (sap72)', () => {
    const failing = new ReflectionNudgeTracker({
      config: { nudgeEveryNthTurn: 1 },
      resolveAdmittedSkills: () => [RELEASE_SKILL],
      resolveOutcomeEvidence: () => { throw new Error('telemetry file is unreadable'); },
      recordPostUseOutcome: () => { throw new Error('telemetry file is unreadable'); },
    });

    // The opportunity still lands, ranked on relevance alone.
    expect(failing.evaluate(complexTurn({
      taskCue: 'walk through the release checklist and verify the release build',
    }))).toContain('release-checklist');
  });

  it('offers the same skill at most once, so the loop never nags', () => {
    const tracker = trackerWith([RELEASE_SKILL]);
    const cue = { taskCue: 'walk through the release checklist and verify the release build' };
    expect(tracker.evaluate(complexTurn(cue))).toContain('release-checklist');
    const second = tracker.evaluate(complexTurn(cue));
    expect(second).not.toContain('release-checklist');
    expect(second).toContain('skill action="create"');
  });
});
