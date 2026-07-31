// Case-level execution budgets and failure classification.
//
// A chat request that reaches its fetch timeout can still finish in the agent.
// The harness first waits for the exact turn and then, if needed, waits for any
// settled turn. Both recovery waits must fit inside the enclosing case timeout.

import { InvalidEnvError, MissingEnvError } from './env.mjs';

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

export class CaseConfigurationError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.name = 'CaseConfigurationError';
    this.reason = reason;
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
  const suggestionSteps = Array.isArray(testCase?.suggestTools) && testCase.suggestTools.length > 0
    ? [{
        suggestTools: testCase.suggestTools,
        timeoutMs: testCase.suggestionTimeoutMs ?? 60_000,
      }]
    : [];
  const steps = [...suggestionSteps, ...baseMessages];
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

export async function withTimeout(label, timeoutMs, run, createTimeoutError) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(createTimeoutError
            ? createTimeoutError()
            : new Error(`${label} timed out after ${timeoutMs}ms`));
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
  createTimeoutError,
  run,
}) {
  const controller = new AbortController();
  const casePromise = Promise.resolve().then(() => run(controller.signal));
  try {
    return await withTimeout(label, timeoutMs, () => casePromise, createTimeoutError);
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

/**
 * Run the case-owned pre-dispatch configuration seam.
 *
 * Typed configuration failures mean this case had no executable fixture. They
 * are visible coverage holes, but cannot contaminate another case, so the
 * matrix continues. Unexpected setup failures retain harness_error semantics.
 */
export async function runCaseSetup(testCase, context) {
  if (typeof testCase?.before !== 'function') return null;
  return testCase.before(context);
}

export function isCaseTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return TIMEOUT_ERROR_PATTERN.test(message);
}

export function caseFailureStatus(error) {
  return classifyCaseFailure(error).status;
}

export function classifyCaseFailure(error) {
  if (isCaseTimeoutError(error)) {
    return { status: 'case_timeout', reason: 'case_timeout' };
  }
  if (error instanceof MissingEnvError) {
    return { status: 'coverage_hole', reason: `missing_env:${error.variable}` };
  }
  if (error instanceof InvalidEnvError) {
    return { status: 'coverage_hole', reason: `invalid_env:${error.variable}` };
  }
  if (error instanceof CaseConfigurationError) {
    return { status: 'coverage_hole', reason: error.reason };
  }
  return {
    status: 'harness_error',
    reason: `harness_error:${error instanceof Error ? error.name : 'unknown'}`,
  };
}

export function isMatrixAbortStatus(status) {
  return MATRIX_ABORT_STATUSES.has(status);
}

export function resolveCaseCoverageHoleReason(testCase, { target, catalogToolNames }) {
  const variants = Array.isArray(testCase?.variants)
    ? testCase.variants.filter((variant) => typeof variant === 'string' && variant.length > 0)
    : [];
  if (variants.length > 0 && !variants.includes(target)) {
    return `variant_excluded:target=${String(target)};supported=${variants.join(',')}`;
  }

  const catalog = new Set(
    (Array.isArray(catalogToolNames) ? catalogToolNames : [])
      .filter((name) => typeof name === 'string' && name.length > 0),
  );
  const missingSuggestedTool = (
    Array.isArray(testCase?.suggestTools) ? testCase.suggestTools : []
  ).find((name) => typeof name === 'string' && !catalog.has(name));
  return missingSuggestedTool
    ? `catalog_tool_missing:${missingSuggestedTool}`
    : null;
}
