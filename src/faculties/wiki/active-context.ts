import type { DisclosureWikiSource } from '../../core/cogsec/disclosure/generation-lineage.js';
import type { WikiScope } from './scope.js';

export type WikiRetrievalContextClass = 'dm' | 'group' | 'focus';

/**
 * mmo9.7.4: the wiki context cache mirrors active-memory's refresh lifecycle
 * (`faculties/memory/active-context.ts`). A turn reads the last-good snapshot
 * synchronously and schedules an off-path refresh; the status makes the
 * degraded/in-flight state explicit rather than silent.
 */
export type WikiRefreshStatus = 'ready' | 'refreshing' | 'degraded';

/**
 * Cached wiki context for one keyed lane (`channelId` + contextClass + scope).
 * `contextClass: null` is the deterministic-gate skip (disabled, or a zero cap
 * for the turn's class): a `ready`, empty, non-degraded snapshot — never a
 * cold miss.
 */
export interface WikiContextSnapshot {
  key: string;
  channelId: string;
  contextClass: WikiRetrievalContextClass | null;
  block: string;
  tokenCount: number;
  selectedCount: number;
  /**
   * jp36.1.1.3: content-free outbound-disclosure facts (ref + sensitivity) for
   * every wiki document rendered into this block, folded into the generation
   * disclosure lineage at the turn seam (bible §9.2 item 3). Wiki world-knowledge
   * authorizes no outward destination, so each source collapses to companion-self.
   */
  disclosureWikiSources?: DisclosureWikiSource[];
  generatedAt: number;
  lastRefreshStartedAt: number;
  lastRefreshCompletedAt?: number;
  refreshStatus: WikiRefreshStatus;
  lastRefreshError?: string;
}

export interface WikiContextKeyInput {
  channelId: string;
  contextClass: WikiRetrievalContextClass;
  allowedScopes?: readonly WikiScope[];
}

/**
 * Deterministic cache key for a wiki context lane. Keyed on channel, the
 * resolved context class (dm/group/focus), and the scope set — NOT the turn's
 * query text. This is the same query-relative-staleness tradeoff active-memory
 * makes (it keys on channel/contact/scope, not exact `contextText`): the block
 * is last-good relative to the query, refreshed off-path every turn.
 */
export function resolveWikiContextKey(input: WikiContextKeyInput): string {
  const scopePart = input.allowedScopes && input.allowedScopes.length > 0
    ? [...input.allowedScopes].sort().join(',')
    : '';
  return [
    `channel:${input.channelId}`,
    `class:${input.contextClass}`,
    `scope:${scopePart}`,
  ].join('|');
}

export function cloneWikiContextSnapshot(
  snapshot: WikiContextSnapshot | null,
): WikiContextSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    ...(snapshot.disclosureWikiSources
      ? { disclosureWikiSources: snapshot.disclosureWikiSources.map(source => ({ ...source })) }
      : {}),
  };
}
