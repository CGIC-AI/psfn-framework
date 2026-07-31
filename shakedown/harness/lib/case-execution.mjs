// Case-level execution budgets and failure classification.
//
// A chat request that reaches its fetch timeout can still finish in the agent.
// The harness first waits for the exact turn and then, if needed, waits for any
// settled turn. Both recovery waits must fit inside the enclosing case timeout.

export const OBSERVED_SUBAGENT_CHILD_TURN_P95_MS = 174_000;

// hrmrq.116: observed apprentice subagent work spent about 32s queued plus 134s
// in the child turn (~174s at P95). Four minutes leaves explicit scheduling and
// archive-settlement headroom without treating normal child work as a hang.
export const SUBAGENT_STEP_TIMEOUT_MS = 240_000;

const MATRIX_ABORT_STATUSES = new Set(['harness_error', 'agent_busy', 'runtime_stale']);
const TIMEOUT_ERROR_PATTERN = / timed out after \d+ms$/u;

export class CaseIsolationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CaseIsolationError';
  }
}

function finiteNonNegative(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function chatStepBudgetMs(step, testCase, defaults) {
  const fetchTimeoutMs = finiteNonNegative(
    step?.timeoutMs ?? testCase?.timeoutMs,
    defaults.fetchTimeoutMs,
  );
  const turnMatchWaitMs = finiteNonNegative(
    step?.turnWaitMs ?? testCase?.turnWaitMs,
    defaults.turnMatchWaitMs,
  );
  const turnSettleMs = finiteNonNegative(
    step?.turnSettleMs ?? testCase?.turnSettleMs,
    defaults.turnSettleMs,
  );
  const postAbortTurnWaitMs = Math.max(
    finiteNonNegative(
      step?.postAbortTurnWaitMs ?? testCase?.postAbortTurnWaitMs,
      defaults.postAbortTurnWaitMs,
    ),
    fetchTimeoutMs,
  );
  const recoveryBudgetMs = fetchTimeoutMs
    + turnMatchWaitMs
    + turnSettleMs
    + (postAbortTurnWaitMs * 2);
  const busyBudgetMs = finiteNonNegative(
    step?.busyRetryWindowMs ?? testCase?.busyRetryWindowMs,
    defaults.busyRetryWindowMs,
  ) + turnMatchWaitMs + turnSettleMs;
  return Math.max(recoveryBudgetMs, busyBudgetMs);
}

export function resolveCaseTimeoutMs(testCase, defaults) {
  const baseMessages = Array.isArray(testCase?.messages) && testCase.messages.length > 0
    ? testCase.messages
    : [{ message: testCase?.message }];
  const activationSteps = Array.isArray(testCase?.activateTools) && testCase.activateTools.length > 0
    ? [{
        activateTools: testCase.activateTools,
        timeoutMs: testCase.activationTimeoutMs ?? 60_000,
      }]
    : [];
  const steps = [...activationSteps, ...baseMessages];
  const dispatchBudgetMs = typeof testCase?.execute === 'function'
    ? chatStepBudgetMs(
        { timeoutMs: testCase.timeoutMs ?? defaults.fetchTimeoutMs },
        testCase,
        defaults,
      )
    : steps.reduce(
        (total, step) => total + chatStepBudgetMs(step, testCase, defaults),
        0,
      );
  const stepDelayBudgetMs = Math.max(0, steps.length - 1)
    * finiteNonNegative(testCase?.stepDelayMs, 800);
  const computedBudgetMs = dispatchBudgetMs
    + stepDelayBudgetMs
    + finiteNonNegative(testCase?.afterTimeoutMs, defaults.afterTimeoutMs)
    + finiteNonNegative(defaults.caseOverheadTimeoutMs);

  // An explicit caseTimeoutMs may add headroom, but can never make the
  // post-abort recovery path unreachable again.
  return Math.max(
    computedBudgetMs,
    finiteNonNegative(testCase?.caseTimeoutMs),
  );
}

export async function withTimeout(label, timeoutMs, run) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('case execution aborted');
}

/**
 * Bound one case and cooperatively cancel it before the matrix advances.
 *
 * A normal case timeout remains local to that case. If case code ignores the
 * abort signal and cannot drain, isolation can no longer be guaranteed, so the
 * distinct CaseIsolationError correctly aborts the matrix instead of allowing
 * late writes to contaminate the following case.
 */
export async function runCaseWithTimeout({
  label,
  timeoutMs,
  cancellationDrainTimeoutMs,
  run,
}) {
  const controller = new AbortController();
  const casePromise = Promise.resolve().then(() => run(controller.signal));
  try {
    return await withTimeout(label, timeoutMs, () => casePromise);
  } catch (error) {
    if (!isCaseTimeoutError(error)) throw error;
    controller.abort(error);
    try {
      await withTimeout(
        `${label} cancellation drain`,
        cancellationDrainTimeoutMs,
        () => casePromise.catch(() => null),
      );
    } catch (drainError) {
      throw new CaseIsolationError(
        `${label} did not stop after cancellation; matrix isolation is no longer guaranteed`,
        { cause: drainError },
      );
    }
    throw error;
  }
}

export function isCaseTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return TIMEOUT_ERROR_PATTERN.test(message);
}

export function caseFailureStatus(error) {
  return isCaseTimeoutError(error) ? 'case_timeout' : 'harness_error';
}

export function isMatrixAbortStatus(status) {
  return MATRIX_ABORT_STATUSES.has(status);
}
