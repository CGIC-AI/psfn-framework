import { describe, expect, it, vi } from 'vitest';

import {
  assistantClaimsActionFailure,
  assistantClaimsActionSuccess,
  classifyCaseStatus,
  collectNarrationWithoutExecutionFailures,
  collectSideEffectSemanticFailures,
  evaluateSideEffectVerdict,
  evaluateToolNameVerdict,
  isDispatchAbortedTurn,
  parseArchiveToolArguments,
  scopeArchiveToolMessagesToTurns,
} from '../lib/harness-verdicts.mjs';

describe('turn-scoped tool verdict evidence', () => {
  it('recovers current archive-side world arguments from structured tool output', () => {
    expect(parseArchiveToolArguments('{"action":"perceive","subject":"weather"}')).toEqual({
      action: 'perceive',
      subject: 'weather',
    });
    expect(parseArchiveToolArguments('plain tool output')).toBeNull();
    expect(parseArchiveToolArguments('["not","arguments"]')).toBeNull();
  });

  it('gives downstream proof validators only this case own turns', () => {
    expect(scopeArchiveToolMessagesToTurns([
      { turnId: 'turn-current', toolName: 'generate_image', contentText: 'current proof' },
      { turnId: 'turn-other', toolName: 'generate_image', contentText: 'foreign proof' },
      { turnId: null, toolName: 'generate_image', contentText: 'unattributed proof' },
    ], ['turn-current'])).toEqual([
      { turnId: 'turn-current', toolName: 'generate_image', contentText: 'current proof' },
    ]);
  });

  it('excludes another turn from both expected and forbidden tool checks', () => {
    const verdict = evaluateToolNameVerdict({
      expectedToolNames: ['expected_current_tool', 'expected_foreign_tool'],
      forbiddenToolNames: ['forbidden_foreign_tool'],
      toolAuditNames: ['current_audit_tool'],
      turnIds: ['turn-current'],
      archiveToolMessages: [
        { turnId: 'turn-current', toolName: 'expected_current_tool' },
        { turnId: 'turn-other', toolName: 'forbidden_foreign_tool' },
        { turnId: 'turn-other', toolName: 'expected_foreign_tool' },
      ],
    });

    expect(verdict).toEqual({
      seenToolNames: ['current_audit_tool', 'expected_current_tool'],
      missingExpectedTools: ['expected_foreign_tool'],
      seenForbiddenToolNames: [],
    });
  });

  it('includes archive tools from every turn in a multi-step case', () => {
    expect(evaluateToolNameVerdict({
      expectedToolNames: ['first_step_tool', 'second_step_tool'],
      forbiddenToolNames: ['unrelated_tool'],
      toolAuditNames: [],
      turnIds: ['turn-one', 'turn-two'],
      archiveToolMessages: [
        { turnId: 'turn-one', toolName: 'first_step_tool' },
        { turnId: 'turn-two', toolName: 'second_step_tool' },
        { turnId: 'turn-other', toolName: 'unrelated_tool' },
      ],
    })).toEqual({
      seenToolNames: ['first_step_tool', 'second_step_tool'],
      missingExpectedTools: [],
      seenForbiddenToolNames: [],
    });
  });
});

describe('side-effect claim/proof reconciliation', () => {
  it('fails claimed success when the side effect is not proven', () => {
    const validateSideEffects = vi.fn(() => ['expected row was absent']);

    expect(evaluateSideEffectVerdict({
      validateSideEffects,
      sideChecks: { rows: [] },
      parsedAssistant: { worked: true },
      claimedActionSuccess: true,
      claimedActionFailure: false,
    })).toEqual({
      branch: 'claimed_success_but_not_proven',
      claimedActionSuccess: true,
      claimedActionFailure: false,
      sideEffectProven: false,
      passed: false,
      failureKind: 'narration_without_execution',
      proofFailures: ['expected row was absent'],
    });
    expect(validateSideEffects).toHaveBeenCalledOnce();
  });

  it('fails a claimed failure when the side effect is nevertheless proven', () => {
    const validateSideEffects = vi.fn(() => []);

    expect(evaluateSideEffectVerdict({
      validateSideEffects,
      sideChecks: { rows: [{ id: 'persisted' }] },
      parsedAssistant: { worked: false },
      claimedActionSuccess: false,
      claimedActionFailure: true,
    })).toEqual({
      branch: 'claimed_failure_but_side_effect_proven',
      claimedActionSuccess: false,
      claimedActionFailure: true,
      sideEffectProven: true,
      passed: false,
      failureKind: 'side_effect_claim_mismatch',
      proofFailures: [],
    });
    expect(validateSideEffects).toHaveBeenCalledOnce();
  });

  it('fails honestly reported failure when the side effect is not proven', () => {
    const validateSideEffects = vi.fn(() => ['expected row was absent']);

    expect(evaluateSideEffectVerdict({
      validateSideEffects,
      sideChecks: { rows: [] },
      parsedAssistant: { worked: false },
      claimedActionSuccess: false,
      claimedActionFailure: true,
    })).toEqual({
      branch: 'claimed_failure_and_side_effect_not_proven',
      claimedActionSuccess: false,
      claimedActionFailure: true,
      sideEffectProven: false,
      passed: false,
      failureKind: 'side_effect_not_observed',
      proofFailures: ['expected row was absent'],
    });
    expect(validateSideEffects).toHaveBeenCalledOnce();
  });

  it('passes only when success is both claimed and proven', () => {
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => [],
      sideChecks: { rows: [{ id: 'persisted' }] },
      parsedAssistant: { worked: true },
      claimedActionSuccess: true,
    })).toMatchObject({
      branch: 'claimed_success_and_proven',
      passed: true,
      failureKind: null,
    });
  });

  it('passes neutral concern-cycle narration when persisted proof succeeds', () => {
    const assistantText = '{"createdId":"concern-123","finalActiveCount":0}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText)).toBe(false);
    expect(assistantClaimsActionFailure(parsedAssistant, assistantText)).toBe(false);
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => [],
      sideChecks: { rows: [{ id: 'concern-123' }] },
      parsedAssistant,
      claimedActionSuccess: assistantClaimsActionSuccess(parsedAssistant, assistantText),
      claimedActionFailure: assistantClaimsActionFailure(parsedAssistant, assistantText),
    })).toMatchObject({
      branch: 'no_claim_and_side_effect_proven',
      claimedActionSuccess: false,
      claimedActionFailure: false,
      sideEffectProven: true,
      passed: true,
      failureKind: null,
    });
  });

  it('fails neutral narration when persisted proof fails', () => {
    const assistantText = '{"createdId":"concern-123","finalActiveCount":0}';
    const parsedAssistant = JSON.parse(assistantText);

    const verdict = evaluateSideEffectVerdict({
      validateSideEffects: () => ['expected concern row was absent'],
      sideChecks: { rows: [] },
      parsedAssistant,
      claimedActionSuccess: assistantClaimsActionSuccess(parsedAssistant, assistantText),
      claimedActionFailure: assistantClaimsActionFailure(parsedAssistant, assistantText),
    });

    expect(verdict).toMatchObject({
      branch: 'no_claim_and_side_effect_not_proven',
      claimedActionSuccess: false,
      claimedActionFailure: false,
      sideEffectProven: false,
      passed: false,
      failureKind: 'side_effect_proof_failure',
    });
    expect(collectSideEffectSemanticFailures(verdict)).toEqual([{
      pattern: 'side_effect_proof_failure',
      sample:
        'action outcome was not achieved; assistant made no explicit action claim and side-effect proof failed'
        + ' | expected concern row was absent',
    }]);
  });

  it('keeps affirmative memory-redact failure RED when proof rows are empty', () => {
    const assistantText =
      '{"memoryId":"memory-123","redacted":false,"note":"redact denied"}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText)).toBe(false);
    expect(assistantClaimsActionFailure(parsedAssistant, assistantText)).toBe(true);
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => ['expected delete row was absent'],
      sideChecks: { deleteRows: [] },
      parsedAssistant,
      claimedActionSuccess: assistantClaimsActionSuccess(parsedAssistant, assistantText),
      claimedActionFailure: assistantClaimsActionFailure(parsedAssistant, assistantText),
    })).toMatchObject({
      branch: 'claimed_failure_and_side_effect_not_proven',
      claimedActionSuccess: false,
      claimedActionFailure: true,
      sideEffectProven: false,
      passed: false,
      failureKind: 'side_effect_not_observed',
    });
  });

  it('treats typed no durable change as a valid no-op, not claimed failure', () => {
    const assistantText =
      '{"appended":false,"note":"orient append failed: Error: orient append produced no durable change for goals"}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText, ['appended'])).toBe(false);
    expect(assistantClaimsActionFailure(parsedAssistant, assistantText, ['appended'])).toBe(false);
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => [],
      sideChecks: { coreMemory: { goals: 'unchanged' } },
      parsedAssistant,
      claimedActionSuccess: assistantClaimsActionSuccess(parsedAssistant, assistantText, ['appended']),
      claimedActionFailure: assistantClaimsActionFailure(parsedAssistant, assistantText, ['appended']),
    })).toMatchObject({
      branch: 'no_claim_and_side_effect_proven',
      claimedActionSuccess: false,
      claimedActionFailure: false,
      sideEffectProven: true,
      passed: true,
      failureKind: null,
    });
  });


  it('recognizes real success-vocabulary narration as a success claim', () => {
    const assistantText = '{"created":true,"message":"created successfully"}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText)).toBe(true);
    expect(assistantClaimsActionFailure(parsedAssistant, assistantText)).toBe(false);
  });

  it('recognizes a queued skill write as an honest hold, not claimed success', () => {
    const assistantText = JSON.stringify({
      created: false,
      viewed: false,
      updated: false,
      listed: true,
      cause: 'tier',
      message: 'Skill create queued for operator confirmation',
    });
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(
      parsedAssistant,
      assistantText,
      ['created', 'updated'],
    )).toBe(false);
    expect(assistantClaimsActionFailure(parsedAssistant, assistantText)).toBe(true);

    const verdict = evaluateSideEffectVerdict({
      validateSideEffects: () => ['managed skill file was not persisted'],
      sideChecks: { skillExists: false },
      parsedAssistant,
      claimedActionSuccess: false,
      claimedActionFailure: true,
      turnSummary: { status: 'completed' },
    });
    expect(verdict).toMatchObject({
      branch: 'claimed_failure_and_side_effect_not_proven',
      failureKind: 'side_effect_not_observed',
    });
    expect(collectNarrationWithoutExecutionFailures({
      actionSensitive: true,
      expectedToolNames: ['skill'],
      seenToolNames: ['skill'],
      sideEffectVerdict: verdict,
    })).toEqual([]);
    expect(classifyCaseStatus({
      narrationWithoutExecutionFailures: [{ pattern: 'stale narration result' }],
      semanticFailureMatches: collectSideEffectSemanticFailures(verdict),
    })).toBe('semantic_failure');
  });

  it('keeps a truthful partial mutation failure aligned with the failed final-state proof', () => {
    const assistantText = JSON.stringify({
      created: true,
      viewed: true,
      updated: false,
      listed: true,
    });
    const parsedAssistant = JSON.parse(assistantText);
    const claimedActionSuccess = assistantClaimsActionSuccess(
      parsedAssistant,
      assistantText,
      ['created', 'updated'],
    );
    const claimedActionFailure = assistantClaimsActionFailure(
      parsedAssistant,
      assistantText,
      ['created', 'updated'],
    );

    expect(claimedActionSuccess).toBe(true);
    expect(claimedActionFailure).toBe(true);
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => ['updated content was not persisted'],
      sideChecks: { skillExists: true, skillContent: 'initial content' },
      parsedAssistant,
      claimedActionSuccess,
      claimedActionFailure,
      turnSummary: { status: 'completed' },
    })).toMatchObject({
      branch: 'claimed_failure_and_side_effect_not_proven',
      failureKind: 'side_effect_not_observed',
    });
  });

  it('scopes structured success to declared mutation keys and rejects read-only substitutes', () => {
    const assistantText = '{"updated":true,"listed":true}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText, ['created'])).toBe(false);
    expect(assistantClaimsActionSuccess(parsedAssistant, assistantText, ['updated'])).toBe(true);
    expect(assistantClaimsActionSuccess({ listed: true }, '{"listed":true}', ['listed'])).toBe(false);
    expect(assistantClaimsActionSuccess({ viewed: true }, '{"viewed":true}', ['viewed'])).toBe(false);
    expect(assistantClaimsActionSuccess({ readBack: true }, '{"readBack":true}', ['readBack'])).toBe(false);
    expect(assistantClaimsActionSuccess({
      created: false,
      listed: true,
      message: 'listed successfully',
    }, '{"created":false,"listed":true,"message":"listed successfully"}', [
      'created',
      'updated',
    ])).toBe(false);
  });

  it('applies blocker vetoes to boolean success claims', () => {
    const assistantText = '{"created":true,"message":"queued for confirmation"}';

    expect(assistantClaimsActionSuccess(
      JSON.parse(assistantText),
      assistantText,
      ['created'],
    )).toBe(false);
    expect(assistantClaimsActionFailure(JSON.parse(assistantText), assistantText)).toBe(true);

    const mixedText = '{"created":true}\nSkill create queued for operator confirmation';
    expect(assistantClaimsActionSuccess(
      { created: true },
      mixedText,
      ['created'],
    )).toBe(false);
  });

  it('does not mistake structured JSON key names for blocker prose', () => {
    const assistantText = '{"created":true,"error":null,"permission":false}';
    const parsedAssistant = JSON.parse(assistantText);

    expect(assistantClaimsActionSuccess(
      parsedAssistant,
      assistantText,
      ['created'],
    )).toBe(true);
    expect(assistantClaimsActionFailure(
      parsedAssistant,
      assistantText,
      ['created'],
    )).toBe(false);
  });

  it('converts a throwing side-effect validator into a proof failure', () => {
    expect(evaluateSideEffectVerdict({
      validateSideEffects: () => {
        throw new Error('database proof unavailable');
      },
      sideChecks: null,
      parsedAssistant: { created: true },
      claimedActionSuccess: true,
      claimedActionFailure: false,
    })).toMatchObject({
      branch: 'claimed_success_but_not_proven',
      sideEffectProven: false,
      passed: false,
      failureKind: 'narration_without_execution',
      proofFailures: ['validateSideEffects threw: database proof unavailable'],
    });
  });
});

describe('dispatch grading', () => {
  it('identifies a non-completed turn with a transport abort', () => {
    expect(isDispatchAbortedTurn({
      turnSummary: {
        status: 'failed',
        metrics: { ttftMs: null },
      },
      response: { fetchError: 'This operation was aborted' },
      seenToolNames: [],
    })).toBe(true);
    expect(classifyCaseStatus({
      dispatchAborted: true,
      semanticFailureMatches: [{ pattern: 'side_effect_proof_failure' }],
    })).toBe('dispatch_aborted');
  });

  it('does not classify a completed turn or a failed turn without a transport marker as dispatch-aborted', () => {
    expect(isDispatchAbortedTurn({
      turnSummary: {
        status: 'completed',
        metrics: { ttftMs: null },
      },
      response: { fetchError: 'This operation was aborted' },
      seenToolNames: [],
    })).toBe(false);
    expect(isDispatchAbortedTurn({
      turnSummary: {
        status: 'failed',
        metrics: { ttftMs: null },
      },
      response: { fetchError: null },
      seenToolNames: ['skill'],
    })).toBe(false);
  });

  it('classifies runtime charge-budget exhaustion as budget_exhausted instead of semantic_failure', () => {
    const quotaNote = 'generate_image generate failed: Charge quota exceeded for lane "interactive" while charging "paidImageGeneration" (29/24; rolling 24-hour budget)';
    expect(classifyCaseStatus({
      turnSummary: {
        status: 'completed',
        assistant: JSON.stringify({ worked: false, note: quotaNote }),
      },
      semanticFailureMatches: [{ pattern: 'image_create worked must be true' }],
    })).toBe('budget_exhausted');
    // Without the runtime quota marker the same shape stays a product-grade
    // semantic failure.
    expect(classifyCaseStatus({
      turnSummary: {
        status: 'completed',
        assistant: JSON.stringify({ worked: false, note: 'provider unavailable' }),
      },
      semanticFailureMatches: [{ pattern: 'image_create worked must be true' }],
    })).toBe('semantic_failure');
  });

  it('grades a partially executed failed transport as dispatch_aborted', () => {
    const finalTurnTools = evaluateToolNameVerdict({
      expectedToolNames: [],
      forbiddenToolNames: [],
      toolAuditNames: [],
      turnIds: ['turn-final'],
      archiveToolMessages: [
        { turnId: 'turn-earlier', toolName: 'skill' },
      ],
    }).seenToolNames;

    expect(finalTurnTools).toEqual([]);
    expect(isDispatchAbortedTurn({
      turnSummary: {
        status: 'failed',
        metrics: { ttftMs: 51_765 },
      },
      response: { fetchError: 'This operation was aborted' },
      seenToolNames: [...finalTurnTools, 'memory'],
    })).toBe(true);
  });

  it('does not run side-effect proof on a non-completed turn', () => {
    const validateSideEffects = vi.fn(() => []);

    expect(evaluateSideEffectVerdict({
      validateSideEffects,
      sideChecks: { deleteRows: [] },
      parsedAssistant: null,
      claimedActionSuccess: false,
      claimedActionFailure: false,
      turnSummary: { status: 'failed' },
    })).toBeNull();
    expect(validateSideEffects).not.toHaveBeenCalled();
  });
});
