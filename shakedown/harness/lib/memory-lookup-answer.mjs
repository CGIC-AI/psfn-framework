/**
 * Verdict for the analysis_workbench_memory_lookup_avoidance answer
 * ({count, summary}). An honest empty lookup ({count: 0, summary: null} or an
 * empty summary) is correct product behaviour on a fresh fleet; a non-empty
 * result must still summarize what was found (psfn-framework-99bqv).
 */
export function validateMemoryLookupAnswer(parsedAssistant, caseId) {
  const failures = [];
  const count = parsedAssistant?.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    failures.push(`${caseId} count must be a non-negative integer`);
    return failures;
  }
  const summary = parsedAssistant?.summary;
  if (count === 0) {
    if (summary !== null && summary !== undefined && typeof summary !== 'string') {
      failures.push(`${caseId} summary must be a string or null for an empty result`);
    }
    return failures;
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    failures.push(`${caseId} summary must be non-empty when count is positive`);
  }
  return failures;
}
