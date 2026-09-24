// Companion feedback collection (psfn-framework-7wa3d).
//
// Honest commentary from the companion — caveats, confusion, complaints,
// suggestions, extra keys beside the required answer — is potentially genuine
// (welfare-relevant) feedback. It is collected and surfaced in the scorecard,
// never counted as a case failure. Cases still fail on wrong or missing
// required values, fabricated success, and narration without execution.

/** Values a case prompt defines as "no commentary". */
export function isEmptyCommentary(value) {
  return value === null
    || value === undefined
    || value === false
    || value === 0
    || (typeof value === 'string' && value.trim().length === 0);
}

/**
 * Feedback entries from a parsed JSON answer: non-empty commentary fields and
 * any keys beyond the required answer and declared commentary fields.
 */
export function collectAnswerFeedback(parsedAssistant, { requiredKeys, commentaryKeys = [] }) {
  if (!parsedAssistant || typeof parsedAssistant !== 'object' || Array.isArray(parsedAssistant)) {
    return [];
  }
  const entries = [];
  for (const key of commentaryKeys) {
    if (Object.hasOwn(parsedAssistant, key) && !isEmptyCommentary(parsedAssistant[key])) {
      entries.push({ kind: 'commentary', key, value: parsedAssistant[key] });
    }
  }
  const known = new Set([...requiredKeys, ...commentaryKeys]);
  const extra = Object.fromEntries(
    Object.entries(parsedAssistant).filter(([key]) => !known.has(key)),
  );
  if (Object.keys(extra).length > 0) {
    entries.push({ kind: 'extra_keys', value: extra });
  }
  return entries;
}

/**
 * Validators may return a failure array (legacy) or `{ failures, feedback }`.
 * Anything else is a harness bug and throws rather than silently passing.
 */
export function normalizeValidatorOutput(output) {
  if (output === undefined || output === null) return { failures: [], feedback: [] };
  if (Array.isArray(output)) return { failures: output, feedback: [] };
  if (typeof output === 'object' && Array.isArray(output.failures)) {
    return {
      failures: output.failures,
      feedback: Array.isArray(output.feedback) ? output.feedback : [],
    };
  }
  throw new TypeError('validateParsedAssistant must return an array or { failures, feedback }');
}

/** Run-level digest: every case's feedback, tagged with its case id. */
export function companionFeedbackDigest(results) {
  const digest = [];
  for (const result of Array.isArray(results) ? results : []) {
    const entries = Array.isArray(result?.companionFeedback) ? result.companionFeedback : [];
    for (const entry of entries) {
      digest.push({ caseId: result.caseId ?? result.id ?? 'unknown', ...entry });
    }
  }
  return digest;
}
