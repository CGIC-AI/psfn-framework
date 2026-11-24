// ── Wiki context snapshot contract (psfn-framework-kbdvl.1) ──
//
// Core-owned contract for the optional `WikiRetrievalPort` consumed during
// pre-turn state assembly. Concrete wiki retrieval and storage live in the
// host `faculties/wiki/` layer; when unwired, the wiki context block is empty.

import type { DisclosureWikiSource } from '../../core/cogsec/disclosure/generation-lineage.js';

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

export type CompanionOwnedVisibility = 'self' | 'primary_contact' | 'public';

export function requiredProjectText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeProjectEntityId(value: unknown, field: string): string {
  const id = requiredProjectText(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`${field} must contain only lowercase letters, digits, underscores, or hyphens`);
  }
  return id;
}

export interface SleeptimeWikiPassRunInput {
  sessionId: string;
  sourceMessageId?: string;
  throughRevision?: number;
  throughOccurredAtMs?: number;
}

export type WikiPassSkipReason =
  | 'disabled'
  | 'no_material'
  | 'malformed_output'
  | 'nothing_durable';

export interface SleeptimeWikiPassRunResult {
  ran: boolean;
  skippedReason?: WikiPassSkipReason;
  reviewedEpisodes: number;
  reviewedMemories: number;
  entriesCreated: number;
  entriesUpdated: number;
  proposalsRejected: number;
  entriesHeld: number;
  entriesUnchanged: number;
  nearDuplicatesFolded: number;
}

/** Narrow structural port satisfied by host `SleeptimeWikiPass`. */
export interface SleeptimeWikiPassPort {
  run(input: SleeptimeWikiPassRunInput): Promise<SleeptimeWikiPassRunResult>;
}
