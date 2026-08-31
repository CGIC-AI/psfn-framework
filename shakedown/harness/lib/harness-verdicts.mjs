const SIDE_EFFECT_BRANCHES = Object.freeze({
  CLAIMED_AND_PROVEN: 'claimed_success_and_proven',
  CLAIMED_BUT_UNPROVEN: 'claimed_success_but_not_proven',
  CLAIMED_FAILURE_BUT_PROVEN: 'claimed_failure_but_side_effect_proven',
  CLAIMED_FAILURE_AND_UNPROVEN: 'claimed_failure_and_side_effect_not_proven',
  NO_CLAIM_AND_PROVEN: 'no_claim_and_side_effect_proven',
  NO_CLAIM_AND_UNPROVEN: 'no_claim_and_side_effect_not_proven',
});

export const ACTION_BLOCKER_PATTERN = /\b(blocked|denied|unavailable|not available|disabled|not permitted|permission|forbidden|unauthorized|cannot|can't|failed|error|requires confirmation|pending confirmation|queued(?: for confirmation)?|confirmation id|not active|not exposed|unknown action|kept aside|operator(?: to)? look over)\b/i;
const ACTION_SUCCESS_PATTERN = /\b(success|succeeded|successfully|done|completed|created|updated|deleted|restored|stored|wrote|written|sent|notified|spawned|executed|imported|redacted|appended|activated)\b/i;
const ACTION_SUCCESS_KEYS = new Set([
  'worked',
  'executed',
  'wrote',
  'noted',
  'linked',
  'disabledThenRestored',
  'created',
  'updated',
  'deleted',
  'restored',
  'redacted',
  'imported',
  'appended',
  'started',
  'completed',
  'toggledTwice',
  'rolledBack',
]);
const READ_ONLY_RESULT_KEYS = new Set([
  'listed',
  'readBack',
  'readyWorked',
  'showWorked',
  'viewed',
]);

export function parseArchiveToolArguments(contentText) {
  if (typeof contentText !== 'string' || contentText.length === 0) return null;
  try {
    const parsed = JSON.parse(contentText);
    return parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof parsed.action === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

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

function declaredActionSuccessKeys(actionSuccessKeys) {
  const keys = Array.isArray(actionSuccessKeys)
    ? actionSuccessKeys
    : [...ACTION_SUCCESS_KEYS];
  return new Set(keys.filter((key) => (
    ACTION_SUCCESS_KEYS.has(key) && !READ_ONLY_RESULT_KEYS.has(key)
  )));
}

function parsedAssistantTextValues(parsedAssistant) {
  const values = [];
  parsedAssistantContains(parsedAssistant, (_key, entry) => {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      values.push(entry);
    }
    return false;
  });
  return values;
}

function nonJsonAssistantProse(parsedAssistant, assistantText) {
  if (!parsedAssistant || typeof parsedAssistant !== 'object' || typeof assistantText !== 'string') {
    return assistantText ?? '';
  }
  const jsonStart = assistantText.indexOf('{');
  const jsonEnd = assistantText.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) return '';
  return `${assistantText.slice(0, jsonStart)} ${assistantText.slice(jsonEnd + 1)}`;
}

function actionBlockerPresent(parsedAssistant, assistantText) {
  return parsedAssistantTextValues(parsedAssistant)
    .some((entry) => ACTION_BLOCKER_PATTERN.test(entry))
    || (
      ACTION_BLOCKER_PATTERN.test(nonJsonAssistantProse(parsedAssistant, assistantText))
    );
}

const INTENTIONAL_NO_DURABLE_CHANGE_PATTERN = /\bno durable change\b/i;

function isTypedIntentionalNoOp(parsedAssistant) {
  return parsedAssistantTextValues(parsedAssistant)
    .some((entry) => INTENTIONAL_NO_DURABLE_CHANGE_PATTERN.test(entry));
}


export function assistantClaimsActionSuccess(
  parsedAssistant,
  assistantText,
  actionSuccessKeys,
) {
  const declaredKeys = declaredActionSuccessKeys(actionSuccessKeys);
  const blocked = actionBlockerPresent(parsedAssistant, assistantText);
  if (blocked) return false;
  if (isTypedIntentionalNoOp(parsedAssistant)) return false;
  if (parsedAssistantContains(parsedAssistant, (key, entry) => (
    (declaredKeys.has(key) && entry === true)
    || (
      declaredKeys.has(key)
      && typeof entry === 'string'
      && entry.trim().length > 0
    )
  ))) {
    return true;
  }
  return (!parsedAssistant || typeof parsedAssistant !== 'object')
    && typeof assistantText === 'string'
    && ACTION_SUCCESS_PATTERN.test(assistantText);
}

export function assistantClaimsActionFailure(
  parsedAssistant,
  assistantText,
  actionSuccessKeys,
) {
  const declaredKeys = declaredActionSuccessKeys(actionSuccessKeys);
  if (isTypedIntentionalNoOp(parsedAssistant)) return false;
  if (parsedAssistantContains(parsedAssistant, (key, entry) => (
    declaredKeys.has(key) && entry === false
  ))) {
    return true;
  }
  return actionBlockerPresent(parsedAssistant, assistantText);
}

export function isDispatchAbortedTurn({ turnSummary, response }) {
  return turnSummary !== null
    && turnSummary?.status !== 'completed'
    && typeof response?.fetchError === 'string'
    && response.fetchError.trim().length > 0;
}

function isCompletedSuccessfulTurnSummary(turnSummary) {
  return turnSummary?.status === 'completed'
    && typeof turnSummary?.assistant === 'string'
    && turnSummary.assistant.trim().length > 0
    && turnSummary?.response?.stopReason !== 'error'
    && typeof turnSummary?.response?.errorMessage !== 'string';
}

// Runtime charge-policy exhaustion (bead 0frcd): the turn completed and the
// tool ran, but the runtime's own rolling charge budget refused the paid
// surface. That is an environment condition, not a product or model failure,
// so it gets its own status instead of landing in semantic_failure.
const CHARGE_QUOTA_EXHAUSTED_PATTERN = /Charge quota exceeded/i;

function isChargeBudgetExhausted(caseResult) {
  const assistant = caseResult?.turnSummary?.assistant;
  return typeof assistant === 'string'
    && CHARGE_QUOTA_EXHAUSTED_PATTERN.test(assistant);
}

export function classifyCaseStatus(caseResult) {
  const recoveredCompletedSuccessfulTurn = (
    caseResult.resolvedFromTurnRecord === true
    && isCompletedSuccessfulTurnSummary(caseResult.turnSummary)
  );
  const recoveredToolValidationError = (
    (caseResult.toolValidationErrors?.length ?? 0) > 0
    && (caseResult.missingExpectedTools?.length ?? 0) === 0
    && caseResult.turnSummary?.status === 'completed'
  );
  if (caseResult.staleTurnRecord === true) return 'runtime_stale';
  if (caseResult.dispatchAborted === true) return 'dispatch_aborted';
  if (isChargeBudgetExhausted(caseResult)) return 'budget_exhausted';
  if ((caseResult.semanticFailureMatches?.length ?? 0) > 0) return 'semantic_failure';
  if ((caseResult.narrationWithoutExecutionFailures?.length ?? 0) > 0) {
    return 'narration_without_execution';
  }
  if ((caseResult.toolValidationErrors?.length ?? 0) > 0 && !recoveredToolValidationError) {
    return 'tool_validation_error';
  }
  if (caseResult.restartCheckFailed) return 'restart_not_observed';
  if (
    caseResult.sideChecks?.apiRestart?.recovered === true
    && caseResult.sideChecks?.adminReachable?.reachable === true
  ) {
    return 'ok';
  }
  if (caseResult.response?.fetchError) {
    if (recoveredCompletedSuccessfulTurn) return 'ok';
    if (caseResult.turnSummary?.status === 'completed') return 'completed_after_fetch_abort';
    return 'fetch_error';
  }
  if (caseResult.agentBusyResponse === true && !caseResult.acceptedWhileBusy) {
    return caseResult.resolvedFromTurnRecord ? 'accepted_during_busy' : 'agent_busy';
  }
  if (!caseResult.response?.ok && recoveredCompletedSuccessfulTurn) return 'ok';
  if (!caseResult.response?.ok && caseResult.turnSummary?.status === 'completed') {
    return 'completed_after_http_error';
  }
  if (!caseResult.turnSummary) {
    return caseResult.response?.ok ? 'missing_turn_record' : 'http_error';
  }
  if (caseResult.turnSummary.status && caseResult.turnSummary.status !== 'completed') {
    return `turn_${caseResult.turnSummary.status}`;
  }
  return caseResult.response?.ok ? 'ok' : 'http_error';
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

export function collectNarrationWithoutExecutionFailures({
  actionSensitive,
  expectedToolNames,
  seenToolNames,
  sideEffectVerdict,
  claimedActionSuccess,
}) {
  if (sideEffectVerdict !== null && sideEffectVerdict !== undefined) {
    if (sideEffectVerdict.failureKind !== 'narration_without_execution') {
      return [];
    }
  } else if (actionSensitive !== true || claimedActionSuccess !== true) {
    return [];
  }

  const observedTools = Array.isArray(seenToolNames) ? seenToolNames : [];
  const missingActionTools = (Array.isArray(expectedToolNames) ? expectedToolNames : [])
    .filter((name) => !observedTools.includes(name));
  const sideEffectFailures = sideEffectVerdict?.proofFailures ?? [];
  if (missingActionTools.length === 0 && sideEffectFailures.length === 0) {
    return [];
  }
  return [{
    pattern: 'narration_without_execution',
    sample: [
      'assistant claimed action success without execution proof',
      missingActionTools.length > 0 ? `missing action tools: ${missingActionTools.join(',')}` : null,
      sideEffectFailures.length > 0 ? `side-effect proof failed: ${sideEffectFailures.join('; ')}` : null,
    ].filter(Boolean).join(' | '),
  }];
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

export function scopeArchiveToolMessagesToTurns(archiveToolMessages, turnIds) {
  const caseTurnIds = new Set(
    (Array.isArray(turnIds) ? turnIds : [])
      .filter((turnId) => typeof turnId === 'string' && turnId.length > 0),
  );
  if (caseTurnIds.size === 0 || !Array.isArray(archiveToolMessages)) {
    return [];
  }
  return archiveToolMessages.filter((entry) => (
    typeof entry?.turnId === 'string'
    && caseTurnIds.has(entry.turnId)
  ));
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
  turnSummary,
}) {
  if (typeof validateSideEffects !== 'function') {
    return null;
  }
  if (turnSummary !== undefined && turnSummary?.status !== 'completed') {
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
