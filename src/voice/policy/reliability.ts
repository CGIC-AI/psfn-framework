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
  task: () => Promise<T>;
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

async function withStageTimeout<T>(
  stage: VoiceRuntimeStage,
  timeoutMs: number,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error(`${stage} stage aborted`);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new VoiceStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${stage} stage aborted`));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    task()
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(toError(error));
      });
  });
}

export async function runWithVoiceStageBudget<T>(options: VoiceStageExecutionOptions<T>): Promise<T> {
  const budgets = options.budgets ?? DEFAULT_VOICE_RELIABILITY_BUDGETS;
  const budget = budgets[options.stage];

  return withRetry(
    () => withStageTimeout(options.stage, budget.timeoutMs, options.task, options.signal),
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
