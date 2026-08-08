// Route-kind observability contract for LLM accounting.
//
// `configured_endpoint` is the current protocol/ownership-neutral route kind
// for a request that crosses a configured OpenAI-compatible endpoint owned by
// the gateway. It replaces the historical `configured_litellm_proxy` value,
// which named a specific upstream implementation rather than the routing
// concept.
//
// Historical usage rows and persisted telemetry may still carry
// `configured_litellm_proxy`. Stored rows are immutable history and are never
// rewritten. Readers normalize the historical value back into the current
// concept through {@link decodeRouteKind} so display, comparison, and
// accounting remain stable across the rename.

import type { LLMProviderObservability } from '../contracts/runtime-base.js';

/** Current canonical route kind for a configured gateway-owned endpoint. */
export const CONFIGURED_ENDPOINT_ROUTE_KIND = 'configured_endpoint' as const;

/**
 * Historical route kind emitted by pre-migration builds for the LiteLLM proxy.
 * Kept readable for historical rows; never written by new code.
 */
export const LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND = 'configured_litellm_proxy' as const;

/** The set of route-kind values new code may emit. */
type RouteKind = LLMProviderObservability['routeKind'];

/**
 * Route-kind-shaped value as it may appear in persisted/historical rows. Readers
 * must accept the historical LiteLLM value even though new writes never emit it.
 */
type StoredRouteKindInput = RouteKind | typeof LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND | string | undefined;

/**
 * Normalize a stored route-kind value into the current canonical concept.
 *
 * Historical `configured_litellm_proxy` rows are decoded as
 * `configured_endpoint` for display and comparison; other recognized values
 * pass through unchanged, and unrecognized/absent values become `undefined`.
 *
 * This never rewrites stored rows: callers that persist route kind must keep
 * the raw value they received. It only reconciles a value back into the
 * current vocabulary for comparison and operator-facing presentation.
 */
export function decodeRouteKind(value: StoredRouteKindInput): RouteKind | undefined {
  if (value === LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND) return CONFIGURED_ENDPOINT_ROUTE_KIND;
  if (value === CONFIGURED_ENDPOINT_ROUTE_KIND
    || value === 'registered_model'
    || value === 'request_base_url') {
    return value;
  }
  return undefined;
}

/**
 * True when a route-kind value (historical or current) denotes a configured
 * gateway-owned endpoint. Used by readers that must treat the renamed concept
 * and its historical spelling identically without rewriting storage.
 */
export function isConfiguredEndpointRouteKind(value: StoredRouteKindInput): boolean {
  return decodeRouteKind(value) === CONFIGURED_ENDPOINT_ROUTE_KIND;
}
