import type { RetryOptions } from '../../llm/retry.js';
import { withRetry } from '../../llm/retry.js';

export type VoiceRuntimeStage = 'ingest' | 'stt' | 'llm' | 'tts' | 'output';

export interface VoiceStageBudget {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
}

export type VoiceReliabilityBudgets = Record<VoiceRuntimeStage, VoiceStageBudget>;

export const DEFAULT_VOICE_RELIABILITY_BUDGETS: VoiceReliabilityBudgets = {
  ingest: { timeoutMs: 8_000, maxRetries: 0, baseDelayMs: 0 },
  stt: { timeoutMs: 20_000, maxRetries: 1, baseDelayMs: 250 },
  llm: { timeoutMs: 45_000, maxRetries: 1, baseDelayMs: 500 },
  tts: { timeoutMs: 25_000, maxRetries: 1, baseDelayMs: 250 },
  output: { timeoutMs: 125_000, maxRetries: 0, baseDelayMs: 0 },
};

export class VoiceStageTimeoutError extends Error {
  readonly stage: VoiceRuntimeStage;
  readonly timeoutMs: number;

  constructor(stage: VoiceRuntimeStage, timeoutMs: number) {
    super(`${stage} stage exceeded timeout budget (${timeoutMs}ms)`);
    this.name = 'VoiceStageTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export interface VoiceStageExecutionOptions<T> {
  stage: VoiceRuntimeStage;
  task: (signal: AbortSignal) => Promise<T>;
  budgets?: VoiceReliabilityBudgets;
  signal?: AbortSignal;
  retryOptions?: Pick<RetryOptions, 'isRetryable' | 'onRetry' | 'sleep'>;
}

export interface FallbackCandidate<T> {
  id: string;
  value: T;
  available?: boolean;
}

function normalizeBudgetValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveVoiceReliabilityBudgets(
  overrides: Partial<Record<VoiceRuntimeStage, Partial<VoiceStageBudget>>> = {},
): VoiceReliabilityBudgets {
  const resolved = { ...DEFAULT_VOICE_RELIABILITY_BUDGETS };

  for (const stage of Object.keys(DEFAULT_VOICE_RELIABILITY_BUDGETS) as VoiceRuntimeStage[]) {
    const base = DEFAULT_VOICE_RELIABILITY_BUDGETS[stage];
    const override = overrides[stage] ?? {};

    resolved[stage] = {
      timeoutMs: normalizeBudgetValue(override.timeoutMs, base.timeoutMs),
      maxRetries: normalizeBudgetValue(override.maxRetries, base.maxRetries),
      baseDelayMs: normalizeBudgetValue(override.baseDelayMs, base.baseDelayMs),
    };
  }

  return resolved;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function createStageAbortError(stage: VoiceRuntimeStage): Error {
  const error = new Error(`${stage} stage aborted`);
  error.name = 'AbortError';
  return error;
}

function mirrorAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }

  const onAbort = () => {
    controller.abort(signal.reason);
  };

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}

async function withStageTimeout<T>(
  stage: VoiceRuntimeStage,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  waitForCancellationAckOnTimeout = false,
): Promise<T> {
  if (signal?.aborted) {
    throw createStageAbortError(stage);
  }

  const attemptAbortController = new AbortController();
  const releaseAbortMirror = mirrorAbortSignal(signal, attemptAbortController);
  let timedOut = false;
  let timeoutError: VoiceStageTimeoutError | null = null;
  let timer: NodeJS.Timeout | undefined;

  const taskPromise = Promise.resolve().then(() => task(attemptAbortController.signal));
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (attemptAbortController.signal.aborted) {
        return;
      }

      timedOut = true;
      timeoutError = new VoiceStageTimeoutError(stage, timeoutMs);
      attemptAbortController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (error) {
    const normalized = toError(error);

    if (timedOut && timeoutError) {
      if (waitForCancellationAckOnTimeout) {
        // Wait for the attempt to acknowledge cancellation before allowing retries.
        await taskPromise.catch(() => undefined);
      } else {
        void taskPromise.catch(() => undefined);
      }
      throw timeoutError;
    }

    if (attemptAbortController.signal.aborted && signal?.aborted) {
      throw createStageAbortError(stage);
    }

    throw normalized;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    releaseAbortMirror();
  }
}

export async function runWithVoiceStageBudget<T>(options: VoiceStageExecutionOptions<T>): Promise<T> {
  const budgets = options.budgets ?? DEFAULT_VOICE_RELIABILITY_BUDGETS;
  const budget = budgets[options.stage];

  return withRetry(
    () => withStageTimeout(
      options.stage,
      budget.timeoutMs,
      options.task,
      options.signal,
      budget.maxRetries > 0,
    ),
    {
      maxRetries: budget.maxRetries,
      baseDelayMs: budget.baseDelayMs,
    },
    options.retryOptions,
  );
}

export function selectFallbackCandidate<T>(
  preferredId: string,
  candidates: Array<FallbackCandidate<T>>,
  failedIds: Iterable<string> = [],
): FallbackCandidate<T> | null {
  if (candidates.length === 0) return null;

  const failedSet = new Set(failedIds);
  const available = candidates.filter((candidate) => candidate.available !== false && !failedSet.has(candidate.id));

  if (available.length === 0) {
    return null;
  }

  const preferred = available.find((candidate) => candidate.id === preferredId);
  if (preferred) {
    return preferred;
  }

  return available[0] ?? null;
}

export function buildFallbackOrder(
  preferredId: string,
  providerIds: string[],
  failedIds: Iterable<string> = [],
): string[] {
  const failedSet = new Set(failedIds);
  const deduped = Array.from(new Set(providerIds)).filter((providerId) => !failedSet.has(providerId));

  const preferredIndex = deduped.indexOf(preferredId);
  if (preferredIndex > 0) {
    const [preferred] = deduped.splice(preferredIndex, 1);
    deduped.unshift(preferred);
  }

  return deduped;
}
