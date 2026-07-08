// ── Wiki scope dimension (Sprint 10, Workstream W5b) ──
//
// A wiki document belongs to exactly one SCOPE:
//   - `personal`            → the companion's own reference knowledge. This is
//                             the default for every existing document and every
//                             companion-driven write path, so absence == personal
//                             and single-companion behavior is byte-identical.
//   - `shared_world:<siteId>` → world knowledge attached to a physical/virtual
//                             site (see places.json). Companions READ shared
//                             scope for their CURRENT site; they never write it
//                             directly — shared writes belong to the deferred
//                             caretaker layer with operator approval. The
//                             personal WikiStore fail-closed rejects any direct
//                             shared-scope write (the leak surface).
//
// Charter Law 32 / §6.26 still holds across both scopes: the wiki is world
// knowledge, NOT lived memory (L0/L0.1/L2).

import { isValidPlaceIdToken } from '../../shared/contracts/places-registry.js';

export const PERSONAL_WIKI_SCOPE = 'personal';
export const SHARED_WORLD_SCOPE_PREFIX = 'shared_world:';

/** A wiki document scope: personal (default) or a site-keyed shared-world scope. */
export type WikiScope = 'personal' | `shared_world:${string}`;

export function isPersonalScope(scope: WikiScope): scope is 'personal' {
  return scope === PERSONAL_WIKI_SCOPE;
}

export function isSharedWorldScope(scope: WikiScope): boolean {
  return scope.startsWith(SHARED_WORLD_SCOPE_PREFIX);
}

/** Compose a shared-world scope from a validated siteId. Throws on a bad token. */
export function sharedWorldScope(siteId: string): WikiScope {
  const trimmed = siteId.trim();
  if (!trimmed || !isValidPlaceIdToken(trimmed)) {
    throw new Error(`wiki shared_world scope requires a valid siteId token, got "${siteId}"`);
  }
  return `${SHARED_WORLD_SCOPE_PREFIX}${trimmed}`;
}

/** Extract the siteId from a shared-world scope, or undefined for personal. */
export function sharedWorldScopeSiteId(scope: WikiScope): string | undefined {
  if (!scope.startsWith(SHARED_WORLD_SCOPE_PREFIX)) return undefined;
  const siteId = scope.slice(SHARED_WORLD_SCOPE_PREFIX.length);
  return siteId.length > 0 ? siteId : undefined;
}

/**
 * Normalize + validate an untrusted scope value. Absent/empty/`personal` all
 * collapse to `personal`; a `shared_world:<siteId>` value has its siteId
 * component validated against the canonical places-registry ID grammar (reused,
 * not re-invented). Any other shape fails closed with a clear error.
 */
export function normalizeWikiScope(value: unknown): WikiScope {
  if (value === undefined || value === null) return PERSONAL_WIKI_SCOPE;
  if (typeof value !== 'string') {
    throw new Error('wiki scope must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === PERSONAL_WIKI_SCOPE) return PERSONAL_WIKI_SCOPE;
  if (!trimmed.startsWith(SHARED_WORLD_SCOPE_PREFIX)) {
    throw new Error(
      `wiki scope must be 'personal' or 'shared_world:<siteId>', got "${trimmed}"`,
    );
  }
  // sharedWorldScope validates the siteId token component and rejects a bare
  // "shared_world:" prefix with no site.
  return sharedWorldScope(trimmed.slice(SHARED_WORLD_SCOPE_PREFIX.length));
}

/**
 * Resolve the effective scope of a document/metadata record: an absent scope is
 * the personal default. Used everywhere the persisted/serialized form may omit
 * the field (personal documents never serialize a scope, keeping them
 * byte-identical to pre-W5b documents).
 */
export function resolveWikiScope(value: unknown): WikiScope {
  return normalizeWikiScope(value);
}

/**
 * The set of scopes a companion may READ this turn: personal ALWAYS, plus the
 * shared-world scope for its current site when situated. Returns `undefined`
 * when unrestricted (single-companion / flag-off) so callers can skip scope
 * filtering entirely and remain byte-identical. Deterministic + pure.
 */
export function resolveReadableWikiScopes(input: {
  multiCompanion: boolean;
  currentSiteId?: string | undefined;
}): readonly WikiScope[] | undefined {
  if (!input.multiCompanion) return undefined;
  const scopes: WikiScope[] = [PERSONAL_WIKI_SCOPE];
  const siteId = input.currentSiteId?.trim();
  if (siteId && isValidPlaceIdToken(siteId)) {
    scopes.push(`${SHARED_WORLD_SCOPE_PREFIX}${siteId}`);
  }
  return scopes;
}
