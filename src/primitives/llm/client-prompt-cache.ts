import { createHash } from 'node:crypto';
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
  /**
   * Companion identity — the MANDATORY outer cache-isolation scope. Without it
   * two companions' affinity tokens cannot be proven disjoint, so the
   * derivation fails closed (no token, cache not engaged for session-keyed
   * providers). This is the load-bearing cross-companion invariant.
   */
  companionId?: string;
  /**
   * Canonical ingress-resolved subject contact
   * (`CorrelationMetadata.viewerMemorySubjectContactId`, never model supplied).
   * Folded into the affinity token as defense in depth so contact-private
   * content that reaches the cacheable prefix can never share a cache entry
   * across contacts, even in the (pathological) case of a shared channel id.
   */
  viewerMemorySubjectContactId?: string;
}

/**
 * Why a channel/request-scoped affinity token could not be derived. The token
 * is fail-closed: a missing outer (companion) or inner (channel/request) scope
 * yields no token rather than a boundary-crossing one.
 */
export type PromptCacheScopeFailure = 'missing_companion_id' | 'missing_channel_id';

function trimmedScopeValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the provider affinity/cache token, or a structured failure reason.
 *
 * Structural cross-companion / cross-contact isolation (fail-closed):
 * - `companionId` is the mandatory OUTER scope. Absent → `missing_companion_id`
 *   (no token): two companions can never be proven to have disjoint tokens
 *   without it.
 * - the INNER scope is the channel id ('channel' scope) or request id
 *   ('request' scope); the channel id already encodes the conversation
 *   (`dm:<contactId>` / `room:<id>`). Absent → `missing_channel_id`.
 * - the canonical subject contact is folded in as defense in depth.
 *
 * Fields are length-prefixed and domain-separated before hashing so no two
 * distinct (companion, contact, scope, inner) tuples can ever collide onto one
 * token. Providers receive only the hash — raw internal / channel / contact
 * identifiers never leave the process — and equal tuples still map to a stable
 * affinity token so caching works within a scope.
 */
export function resolvePromptCacheAffinity(
  scope: PromptCacheScope,
  correlation: PromptCacheCorrelation | undefined,
): { sessionId: string } | { failure: PromptCacheScopeFailure } {
  const companionId = trimmedScopeValue(correlation?.companionId);
  if (!companionId) return { failure: 'missing_companion_id' };
  const inner = scope === 'request'
    ? trimmedScopeValue(correlation?.requestId)
    : trimmedScopeValue(correlation?.channelId);
  if (!inner) return { failure: 'missing_channel_id' };
  const contactId = trimmedScopeValue(correlation?.viewerMemorySubjectContactId) ?? '';
  const material = [
    'psfnpc.v2',
    `companion:${companionId.length}:${companionId}`,
    `contact:${contactId.length}:${contactId}`,
    `scope:${scope}`,
    `inner:${inner.length}:${inner}`,
  ].join('\u0000');
  return {
    sessionId: `psfnpc-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`,
  };
}

export interface PromptCacheRequestOptions<PayloadModel = unknown> {
  cacheRetention?: PromptCacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, payloadModel: PayloadModel) => unknown | Promise<unknown>;
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
  const resolved = resolvePromptCacheAffinity(scope, correlation);
  return 'sessionId' in resolved ? resolved.sessionId : undefined;
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

  const affinity = resolvePromptCacheAffinity(scope, input.correlation);
  if ('failure' in affinity) {
    return {
      configured: true,
      engaged: false,
      strategy: input.promptCacheStrategy,
      retention,
      scope,
      reason: affinity.failure,
    };
  }

  return {
    configured: true,
    engaged: true,
    strategy: input.promptCacheStrategy,
    retention,
    scope,
    sessionId: affinity.sessionId,
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
export function applyModelAgnosticPromptCache<PayloadModel>(input: PromptCacheCandidateConfig & {
  promptCacheEnabled?: boolean;
  provider: string;
  modelId: string;
  resolvedModelId: string;
  modelApi: string | undefined;
  systemPrompt: string;
  boundaries: LLMSystemPromptCacheBoundaries | undefined;
  correlation: PromptCacheCorrelation | undefined;
  requestOptions: PromptCacheRequestOptions<PayloadModel>;
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
