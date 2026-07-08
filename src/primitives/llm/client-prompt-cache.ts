import type {
  LLMPromptCacheObservability,
  LLMSystemPromptCacheBoundaries,
  PromptCacheMechanism,
  PromptCacheRetention,
  PromptCacheScope,
  PromptCacheStrategy,
} from '../../shared/contracts/runtime.js';
import {
  createSystemPromptCacheControlPayloadTransformer,
  resolvePromptCacheMechanism,
  verifySystemPromptCacheBoundaries,
  type PromptCachePayloadReport,
} from './prompt-cache.js';

type CacheControlMechanism = Extract<
  PromptCacheMechanism,
  'anthropic_cache_control' | 'openrouter_cache_control_passthrough'
>;

export interface PromptCacheCorrelation {
  requestId?: string;
  channelId?: string;
}

export interface PromptCacheRequestOptions {
  cacheRetention?: PromptCacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, payloadModel: unknown) => unknown | Promise<unknown>;
}

export interface PromptCacheBoundaryWarningPayload {
  provider: string;
  model: string;
  mechanism: CacheControlMechanism;
  staticPrefixChars: number;
  sessionStablePrefixChars: number;
  systemPromptChars: number;
}

interface PromptCacheCandidateConfig {
  promptCacheStrategy?: PromptCacheStrategy;
  promptCacheRetention?: PromptCacheRetention;
  promptCacheScope?: PromptCacheScope;
}

function resolveSessionIdForScope(
  scope: PromptCacheScope,
  correlation: PromptCacheCorrelation | undefined,
): string | undefined {
  return scope === 'request'
    ? correlation?.requestId
    : correlation?.channelId;
}

function supportsCacheControlBreakpoints(
  mechanism: PromptCacheMechanism,
): mechanism is CacheControlMechanism {
  return mechanism === 'anthropic_cache_control'
    || mechanism === 'openrouter_cache_control_passthrough';
}

export function resolvePromptCacheSessionId(
  input: PromptCacheCandidateConfig & {
    correlation: PromptCacheCorrelation | undefined;
  },
): string | undefined {
  if (!input.promptCacheStrategy || input.promptCacheRetention === 'none') {
    return undefined;
  }
  return resolveSessionIdForScope(input.promptCacheScope ?? 'channel', input.correlation);
}

export function buildPromptCacheObservability(
  input: PromptCacheCandidateConfig & {
    correlation: PromptCacheCorrelation | undefined;
  },
): LLMPromptCacheObservability {
  if (!input.promptCacheStrategy) {
    return {
      configured: false,
      engaged: false,
    };
  }

  const retention = input.promptCacheRetention ?? 'short';
  const scope = input.promptCacheScope ?? 'channel';
  if (retention === 'none') {
    return {
      configured: true,
      engaged: false,
      strategy: input.promptCacheStrategy,
      retention,
      scope,
      reason: 'disabled',
    };
  }

  const sessionId = resolvePromptCacheSessionId(input);
  if (!sessionId) {
    return {
      configured: true,
      engaged: false,
      strategy: input.promptCacheStrategy,
      retention,
      scope,
      reason: 'missing_channel_id',
    };
  }

  return {
    configured: true,
    engaged: true,
    strategy: input.promptCacheStrategy,
    retention,
    scope,
    sessionId,
  };
}

/**
 * Model-agnostic provider cache engagement (E2.4): applied when the
 * models.json registry-wide promptCaching policy is enabled. Mutates the
 * request options with the params the resolved provider actually supports
 * (cacheRetention / sessionId / cache_control onPayload transformer) and
 * returns the promptCaching observability reflecting what was applied.
 * Returns null when the flag is off — zero wire change.
 */
export function applyModelAgnosticPromptCache(input: PromptCacheCandidateConfig & {
  promptCacheEnabled?: boolean;
  provider: string;
  modelId: string;
  resolvedModelId: string;
  modelApi: string | undefined;
  systemPrompt: string;
  boundaries: LLMSystemPromptCacheBoundaries | undefined;
  correlation: PromptCacheCorrelation | undefined;
  requestOptions: PromptCacheRequestOptions;
  onBoundaryMismatch: (payload: PromptCacheBoundaryWarningPayload) => void;
}): LLMPromptCacheObservability | null {
  if (input.promptCacheEnabled !== true) return null;

  const retention: PromptCacheRetention = input.promptCacheRetention ?? 'short';
  const scope = input.promptCacheScope ?? 'channel';
  // input.modelId is the requested (registry-identity) model id — e.g.
  // 'anthropic/claude-sonnet-4.5' on OpenRouter — which is the stable
  // discriminator even when a proxy route rewrites the backend model id.
  const mechanism = resolvePromptCacheMechanism({
    provider: input.provider,
    modelId: input.modelId,
    api: input.modelApi,
  });
  if (retention === 'none') {
    return {
      configured: true,
      engaged: false,
      retention,
      scope,
      mechanism,
      reason: 'disabled',
      ...(input.promptCacheStrategy ? { strategy: input.promptCacheStrategy } : {}),
    };
  }

  const sessionId = resolveSessionIdForScope(scope, input.correlation);
  if (input.requestOptions.cacheRetention === undefined) {
    input.requestOptions.cacheRetention = retention;
  }
  if (input.requestOptions.sessionId === undefined && sessionId) {
    input.requestOptions.sessionId = sessionId;
  }

  const observability: LLMPromptCacheObservability = {
    configured: true,
    engaged: true,
    retention,
    scope,
    mechanism,
    ...(input.promptCacheStrategy ? { strategy: input.promptCacheStrategy } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  const boundaries = input.boundaries;
  if (boundaries && supportsCacheControlBreakpoints(mechanism)) {
    if (!verifySystemPromptCacheBoundaries(input.systemPrompt, boundaries)) {
      input.onBoundaryMismatch({
        provider: input.provider,
        model: input.resolvedModelId,
        mechanism,
        staticPrefixChars: boundaries.staticPrefixChars,
        sessionStablePrefixChars: boundaries.sessionStablePrefixChars,
        systemPromptChars: input.systemPrompt.length,
      });
      return observability;
    }
    observability.boundaries = {
      staticPrefixChars: boundaries.staticPrefixChars,
      sessionStablePrefixChars: boundaries.sessionStablePrefixChars,
    };
    const report: PromptCachePayloadReport = { appliedBreakpoints: 0 };
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism,
      boundaries,
      retention,
      report,
    });
    const existingOnPayload = input.requestOptions.onPayload;
    input.requestOptions.onPayload = async (payload, payloadModel) => {
      const transformed = transformer(payload, payloadModel);
      if (report.appliedBreakpoints > 0) {
        observability.appliedBreakpoints = report.appliedBreakpoints;
      }
      const next = transformed ?? payload;
      const chained = await existingOnPayload?.(next, payloadModel);
      return chained ?? (transformed !== undefined ? next : undefined);
    };
  }

  return observability;
}
