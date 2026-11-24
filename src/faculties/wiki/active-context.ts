import type {
  WikiContextSnapshot,
  WikiRefreshStatus,
  WikiRetrievalContextClass,
} from '../../shared/contracts/wiki-context.js';
export type {
  WikiContextSnapshot,
  WikiRefreshStatus,
  WikiRetrievalContextClass,
} from '../../shared/contracts/wiki-context.js';
import type { WikiScope } from './scope.js';

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
