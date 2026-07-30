const SIDE_EFFECT_BRANCHES = Object.freeze({
  CLAIMED_AND_PROVEN: 'claimed_success_and_proven',
  CLAIMED_BUT_UNPROVEN: 'claimed_success_but_not_proven',
  CLAIMED_FAILURE_BUT_PROVEN: 'claimed_failure_but_side_effect_proven',
  CLAIMED_FAILURE_AND_UNPROVEN: 'claimed_failure_and_side_effect_not_proven',
  NO_CLAIM_AND_PROVEN: 'no_claim_and_side_effect_proven',
  NO_CLAIM_AND_UNPROVEN: 'no_claim_and_side_effect_not_proven',
});

export const ACTION_BLOCKER_PATTERN = /\b(blocked|denied|unavailable|not available|disabled|not permitted|permission|forbidden|unauthorized|cannot|can't|failed|error|requires confirmation|pending confirmation|queued for confirmation|confirmation id|not active|not exposed|unknown action)\b/i;
const ACTION_SUCCESS_PATTERN = /\b(success|succeeded|successfully|done|completed|created|updated|deleted|restored|stored|wrote|written|sent|notified|spawned|executed|imported|redacted|appended|activated)\b/i;
const ACTION_SUCCESS_KEYS = new Set([
  'worked',
  'executed',
  'wrote',
  'readBack',
  'noted',
  'linked',
  'disabledThenRestored',
  'created',
  'updated',
  'deleted',
  'redacted',
  'imported',
  'appended',
  'started',
  'completed',
  'toggledTwice',
  'readyWorked',
  'showWorked',
  'rolledBack',
  'viewed',
  'listed',
]);

function parsedAssistantContains(parsedAssistant, predicate) {
  if (!parsedAssistant || typeof parsedAssistant !== 'object') {
    return false;
  }
  const stack = [parsedAssistant];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (predicate(key, entry)) {
        return true;
      }
      if (entry && typeof entry === 'object') {
        stack.push(entry);
      }
    }
  }
  return false;
}

export function assistantClaimsActionSuccess(parsedAssistant, assistantText) {
  if (parsedAssistantContains(parsedAssistant, (key, entry) => (
    (ACTION_SUCCESS_KEYS.has(key) && entry === true)
    || (
      ACTION_SUCCESS_KEYS.has(key)
      && typeof entry === 'string'
      && entry.trim().length > 0
      && !ACTION_BLOCKER_PATTERN.test(entry)
    )
  ))) {
    return true;
  }
  if (typeof assistantText !== 'string' || assistantText.trim().length === 0) {
    return false;
  }
  return ACTION_SUCCESS_PATTERN.test(assistantText) && !ACTION_BLOCKER_PATTERN.test(assistantText);
}

export function assistantClaimsActionFailure(parsedAssistant, assistantText) {
  if (parsedAssistantContains(parsedAssistant, (key, entry) => (
    ACTION_SUCCESS_KEYS.has(key) && entry === false
  ))) {
    return true;
  }
  return typeof assistantText === 'string' && ACTION_BLOCKER_PATTERN.test(assistantText);
}

export function collectSideEffectSemanticFailures(sideEffectVerdict) {
  if (sideEffectVerdict?.failureKind === 'side_effect_claim_mismatch') {
    return [{
      pattern: sideEffectVerdict.failureKind,
      sample: 'assistant reported action failure, but the side-effect proof shows the action succeeded',
    }];
  }
  if (sideEffectVerdict?.failureKind === 'side_effect_not_observed') {
    return [{
      pattern: sideEffectVerdict.failureKind,
      sample: [
        'action outcome was not achieved; assistant reported failure and side-effect proof confirmed it',
        ...sideEffectVerdict.proofFailures,
      ].join(' | '),
    }];
  }
  if (sideEffectVerdict?.failureKind === 'side_effect_proof_failure') {
    return [{
      pattern: sideEffectVerdict.failureKind,
      sample: [
        'action outcome was not achieved; assistant made no explicit action claim and side-effect proof failed',
        ...sideEffectVerdict.proofFailures,
      ].join(' | '),
    }];
  }
  return [];
}

export function collectCaseSeenToolNames({
  toolAuditNames,
  archiveToolMessages,
  turnIds,
}) {
  const caseTurnIds = new Set(
    (Array.isArray(turnIds) ? turnIds : [])
      .filter((turnId) => typeof turnId === 'string' && turnId.length > 0),
  );
  return [...new Set([
    ...(Array.isArray(toolAuditNames) ? toolAuditNames : []),
    ...(Array.isArray(archiveToolMessages) ? archiveToolMessages : [])
      .filter((entry) => (
        typeof entry?.turnId === 'string'
        && caseTurnIds.has(entry.turnId)
      ))
      .map((entry) => entry?.toolName),
  ])]
    .filter((toolName) => typeof toolName === 'string' && toolName.length > 0);
}

export function evaluateToolNameVerdict({
  expectedToolNames,
  forbiddenToolNames,
  toolAuditNames,
  archiveToolMessages,
  turnIds,
}) {
  const seenToolNames = collectCaseSeenToolNames({
    toolAuditNames,
    archiveToolMessages,
    turnIds,
  });
  return {
    seenToolNames,
    missingExpectedTools: (Array.isArray(expectedToolNames) ? expectedToolNames : [])
      .filter((toolName) => !seenToolNames.includes(toolName)),
    seenForbiddenToolNames: (Array.isArray(forbiddenToolNames) ? forbiddenToolNames : [])
      .filter((toolName) => (
        typeof toolName === 'string'
        && seenToolNames.includes(toolName)
      )),
  };
}

export function evaluateSideEffectVerdict({
  validateSideEffects,
  sideChecks,
  parsedAssistant,
  claimedActionSuccess,
  claimedActionFailure,
}) {
  if (typeof validateSideEffects !== 'function') {
    return null;
  }
  let rawFailures;
  try {
    rawFailures = validateSideEffects({ sideChecks, parsedAssistant });
  } catch (error) {
    rawFailures = [
      `validateSideEffects threw: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const proofFailures = Array.isArray(rawFailures)
    ? rawFailures.filter((failure) => typeof failure === 'string' && failure.trim().length > 0)
    : ['validateSideEffects must return an array of failure strings'];
  const claimedSuccess = claimedActionSuccess === true;
  const claimedFailure = claimedActionFailure === true;
  const sideEffectProven = proofFailures.length === 0;

  if (claimedFailure && sideEffectProven) {
    return {
      branch: SIDE_EFFECT_BRANCHES.CLAIMED_FAILURE_BUT_PROVEN,
      claimedActionSuccess: claimedSuccess,
      claimedActionFailure: true,
      sideEffectProven: true,
      passed: false,
      failureKind: 'side_effect_claim_mismatch',
      proofFailures,
    };
  }
  if (claimedFailure) {
    return {
      branch: SIDE_EFFECT_BRANCHES.CLAIMED_FAILURE_AND_UNPROVEN,
      claimedActionSuccess: claimedSuccess,
      claimedActionFailure: true,
      sideEffectProven: false,
      passed: false,
      failureKind: 'side_effect_not_observed',
      proofFailures,
    };
  }
  if (claimedSuccess && sideEffectProven) {
    return {
      branch: SIDE_EFFECT_BRANCHES.CLAIMED_AND_PROVEN,
      claimedActionSuccess: true,
      claimedActionFailure: false,
      sideEffectProven: true,
      passed: true,
      failureKind: null,
      proofFailures,
    };
  }
  if (claimedSuccess) {
    return {
      branch: SIDE_EFFECT_BRANCHES.CLAIMED_BUT_UNPROVEN,
      claimedActionSuccess: true,
      claimedActionFailure: false,
      sideEffectProven: false,
      passed: false,
      failureKind: 'narration_without_execution',
      proofFailures,
    };
  }
  if (sideEffectProven) {
    return {
      branch: SIDE_EFFECT_BRANCHES.NO_CLAIM_AND_PROVEN,
      claimedActionSuccess: false,
      claimedActionFailure: false,
      sideEffectProven: true,
      passed: true,
      failureKind: null,
      proofFailures,
    };
  }
  return {
    branch: SIDE_EFFECT_BRANCHES.NO_CLAIM_AND_UNPROVEN,
    claimedActionSuccess: false,
    claimedActionFailure: false,
    sideEffectProven: false,
    passed: false,
    failureKind: 'side_effect_proof_failure',
    proofFailures,
  };
}
