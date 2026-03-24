import { createComponentLogger } from '../logger.js';
import type { CorrelationMetadata } from '../types.js';
import { classifyLLMError } from './error-classify.js';
import type { RoutingCandidate, RoutingPurpose } from './routing.js';
import { toCorrelationLogFields } from './correlation.js';

const log = createComponentLogger('ModelFallback');

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 45_000;

export interface FallbackRunnerOptions {
  rateLimitCooldownMs?: number;
  now?: () => number;
}

export interface FallbackRunResult<T> {
  result: T;
  candidate: RoutingCandidate;
  attempts: number;
}

export class NonRecoverableFallbackError extends Error {
  readonly causeError: Error;

  constructor(error: Error) {
    super(error.message);
    this.name = 'NonRecoverableFallbackError';
    this.causeError = error;
  }
}

interface CooldownCandidate {
  candidate: RoutingCandidate;
  cooldownUntil: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unwrapFallbackError(error: unknown): Error {
  if (error instanceof NonRecoverableFallbackError) {
    return error.causeError;
  }
  return toError(error);
}

function candidateKey(candidate: RoutingCandidate): string {
  return [
    candidate.provider,
    candidate.model,
    candidate.requestBaseUrl ?? '',
    candidate.openRouterZdrOnly ? 'zdr' : '',
    candidate.importRouteMode ?? '',
  ].join('::');
}

export class FallbackRunner {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly cooldownUntilByCandidate = new Map<string, number>();

  constructor(options: FallbackRunnerOptions = {}) {
    this.cooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private getCooldownUntil(candidate: RoutingCandidate): number | undefined {
    return this.cooldownUntilByCandidate.get(candidateKey(candidate));
  }

  private clearCooldown(candidate: RoutingCandidate): void {
    this.cooldownUntilByCandidate.delete(candidateKey(candidate));
  }

  private markCooldown(candidate: RoutingCandidate): number {
    const cooldownUntil = this.now() + this.cooldownMs;
    this.cooldownUntilByCandidate.set(candidateKey(candidate), cooldownUntil);
    return cooldownUntil;
  }

  private orderCandidates(candidates: RoutingCandidate[]): RoutingCandidate[] {
    const now = this.now();
    const ready: RoutingCandidate[] = [];
    const cooldown: CooldownCandidate[] = [];

    for (const candidate of candidates) {
      const cooldownUntil = this.getCooldownUntil(candidate);
      if (cooldownUntil !== undefined && cooldownUntil > now) {
        cooldown.push({ candidate, cooldownUntil });
      } else {
        ready.push(candidate);
      }
    }

    cooldown.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...ready, ...cooldown.map((entry) => entry.candidate)];
  }

  private handleCandidateFailure(
    purpose: RoutingPurpose,
    orderedCandidates: RoutingCandidate[],
    attempt: number,
    rawError: unknown,
    correlationFields: Partial<CorrelationMetadata>,
  ): never | void {
    const explicitNonRecoverable = rawError instanceof NonRecoverableFallbackError;
    const err = unwrapFallbackError(rawError);
    const candidate = orderedCandidates[attempt - 1]!;
    const classification = classifyLLMError(err);
    const isLastAttempt = attempt >= orderedCandidates.length;

    if (classification.category === 'rate_limit') {
      const nextCooldownUntil = this.markCooldown(candidate);
      log.warn('Rate limit hit; marking candidate cooldown', {
        purpose,
        model: candidate.model,
        provider: candidate.provider,
        cooldownMs: this.cooldownMs,
        cooldownUntil: new Date(nextCooldownUntil).toISOString(),
        attempt,
        ...correlationFields,
      });
    }

    if (explicitNonRecoverable || classification.category === 'abort' || classification.category === 'context_overflow') {
      log.warn('Stopping fallback due to non-recoverable classification', {
        purpose,
        category: explicitNonRecoverable ? 'explicit_non_recoverable' : classification.category,
        model: candidate.model,
        provider: candidate.provider,
        attempt,
        error: err.message,
        ...correlationFields,
      });
      throw err;
    }

    if (isLastAttempt) {
      log.error('All fallback candidates exhausted', {
        purpose,
        attempts: attempt,
        lastCategory: classification.category,
        lastError: err.message,
        ...correlationFields,
      });
      throw err;
    }

    log.warn('Candidate failed; trying fallback model', {
      purpose,
      attempt,
      errorCategory: classification.category,
      failedModel: candidate.model,
      failedProvider: candidate.provider,
      nextModel: orderedCandidates[attempt]?.model,
      nextProvider: orderedCandidates[attempt]?.provider,
      error: err.message,
      ...correlationFields,
    });
  }

  async run<T>(
    purpose: RoutingPurpose,
    candidates: RoutingCandidate[],
    execute: (candidate: RoutingCandidate, attempt: number) => Promise<T>,
    correlation?: Partial<CorrelationMetadata>,
  ): Promise<FallbackRunResult<T>> {
    if (candidates.length === 0) {
      throw new Error(`No model candidates resolved for purpose "${purpose}"`);
    }

    const orderedCandidates = this.orderCandidates(candidates);
    const correlationFields = buildFallbackCorrelation(correlation, purpose);
    let lastError: Error | null = null;

    for (let index = 0; index < orderedCandidates.length; index += 1) {
      const candidate = orderedCandidates[index];
      const attempt = index + 1;
      const cooldownUntil = this.getCooldownUntil(candidate);
      const now = this.now();
      const cooldownRemainingMs = cooldownUntil && cooldownUntil > now
        ? cooldownUntil - now
        : 0;
      const inCooldown = cooldownRemainingMs > 0;

      if (inCooldown) {
        log.info('Probing candidate after cooldown deferment', {
          purpose,
          attempt,
          model: candidate.model,
          provider: candidate.provider,
          cooldownRemainingMs,
          ...correlationFields,
        });
      } else {
        log.info('Selected model candidate', {
          purpose,
          attempt,
          model: candidate.model,
          provider: candidate.provider,
          slotKey: candidate.slotKey,
          ...correlationFields,
        });
      }

      try {
        const result = await execute(candidate, attempt);
        this.clearCooldown(candidate);
        if (attempt > 1) {
          log.info('Model fallback resolved request', {
            purpose,
            attempts: attempt,
            model: candidate.model,
            provider: candidate.provider,
            ...correlationFields,
          });
        }
        return { result, candidate, attempts: attempt };
      } catch (error) {
        lastError = unwrapFallbackError(error);
        this.handleCandidateFailure(purpose, orderedCandidates, attempt, error, correlationFields);
      }
    }

    throw lastError ?? new Error(`Fallback runner failed for purpose "${purpose}"`);
  }

  async *runStream<T>(
    purpose: RoutingPurpose,
    candidates: RoutingCandidate[],
    execute: (candidate: RoutingCandidate, attempt: number) => AsyncIterable<T>,
    correlation?: Partial<CorrelationMetadata>,
  ): AsyncGenerator<T, void, unknown> {
    if (candidates.length === 0) {
      throw new Error(`No model candidates resolved for purpose "${purpose}"`);
    }

    const orderedCandidates = this.orderCandidates(candidates);
    const correlationFields = buildFallbackCorrelation(correlation, purpose);

    for (let index = 0; index < orderedCandidates.length; index += 1) {
      const candidate = orderedCandidates[index];
      const attempt = index + 1;
      const cooldownUntil = this.getCooldownUntil(candidate);
      const now = this.now();
      const cooldownRemainingMs = cooldownUntil && cooldownUntil > now
        ? cooldownUntil - now
        : 0;
      const inCooldown = cooldownRemainingMs > 0;

      if (inCooldown) {
        log.info('Probing candidate after cooldown deferment', {
          purpose,
          attempt,
          model: candidate.model,
          provider: candidate.provider,
          cooldownRemainingMs,
          ...correlationFields,
        });
      } else {
        log.info('Selected model candidate', {
          purpose,
          attempt,
          model: candidate.model,
          provider: candidate.provider,
          slotKey: candidate.slotKey,
          ...correlationFields,
        });
      }

      try {
        yield* execute(candidate, attempt);
        this.clearCooldown(candidate);
        if (attempt > 1) {
          log.info('Model fallback resolved request', {
            purpose,
            attempts: attempt,
            model: candidate.model,
            provider: candidate.provider,
            ...correlationFields,
          });
        }
        return;
      } catch (error) {
        this.handleCandidateFailure(purpose, orderedCandidates, attempt, error, correlationFields);
      }
    }
  }
}

function buildFallbackCorrelation(
  correlation: Partial<CorrelationMetadata> | undefined,
  purpose: RoutingPurpose,
): Partial<CorrelationMetadata> {
  const normalized = toCorrelationLogFields(correlation);
  return {
    ...(correlation?.turnId ? { turnId: correlation.turnId } : {}),
    requestId: normalized.requestId,
    ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
    ...(correlation?.callType ? { callType: correlation.callType } : {}),
    ...(correlation?.toolName ? { toolName: correlation.toolName } : {}),
    ...(correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    purpose: correlation?.purpose ?? purpose,
    originType: normalized.originType,
    originStage: normalized.originStage,
  };
}
