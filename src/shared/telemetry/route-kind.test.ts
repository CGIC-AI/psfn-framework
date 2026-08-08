import { describe, expect, it } from 'vitest';
import {
  CONFIGURED_ENDPOINT_ROUTE_KIND,
  LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND,
  decodeRouteKind,
  isConfiguredEndpointRouteKind,
} from './route-kind.js';

describe('route-kind observability rename', () => {
  it('exposes the configured_endpoint concept as the canonical value', () => {
    expect(CONFIGURED_ENDPOINT_ROUTE_KIND).toBe('configured_endpoint');
    expect(LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND).toBe('configured_litellm_proxy');
  });

  it('emits the new configured_endpoint route kind from production code', () => {
    // New writes use the protocol/ownership-neutral value, not the upstream
    // implementation name.
    expect(decodeRouteKind(CONFIGURED_ENDPOINT_ROUTE_KIND)).toBe('configured_endpoint');
  });

  it('decodes historical configured_litellm_proxy rows as configured_endpoint without rewriting them', () => {
    // Historical persisted rows carry the old spelling. Readers normalize the
    // value back into the current concept for display and comparison; the raw
    // stored value is never rewritten.
    expect(decodeRouteKind(LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND))
      .toBe('configured_endpoint');
  });

  it('passes registered_model and request_base_url route kinds through unchanged', () => {
    expect(decodeRouteKind('registered_model')).toBe('registered_model');
    expect(decodeRouteKind('request_base_url')).toBe('request_base_url');
  });

  it('treats absent and unrecognized route kinds as unknown', () => {
    expect(decodeRouteKind(undefined)).toBeUndefined();
    expect(decodeRouteKind('something-new')).toBeUndefined();
  });

  it('recognizes both current and historical configured-endpoint spellings', () => {
    expect(isConfiguredEndpointRouteKind(CONFIGURED_ENDPOINT_ROUTE_KIND)).toBe(true);
    expect(isConfiguredEndpointRouteKind(LEGACY_CONFIGURED_LITELLM_PROXY_ROUTE_KIND)).toBe(true);
    expect(isConfiguredEndpointRouteKind('registered_model')).toBe(false);
    expect(isConfiguredEndpointRouteKind(undefined)).toBe(false);
  });
});
