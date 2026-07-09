// ── Garden admin service: cogsec drift review cards (htm9.14, htm9.15) ──
//
// Thin operator-capability wrapper over the drift review card store the
// nightly drift lanes write. Only reachable through the operator-
// authenticated /api/admin surface. Acknowledging or dismissing a card
// records the operator decision on the card itself — and NOTHING else.
//
// The single deliberate exception (htm9.15): resolving a SECOND-ARROW card
// as 'consolidated' applies the card's proposed consolidation via the
// existing memory-supersession machinery — updateMemory(supersededBy) plus
// 'supersedes' evolution links, exactly what the writer's own evolution path
// uses. Never deletion: superseded memories stay on disk, drop out of
// retrieval, and remain reversible through the memory admin surface. The
// nightly lanes themselves never mutate anything; only this operator-
// approved path does, and the route audits every attempt.

import type {
  DriftReviewCard,
  DriftReviewCardResolution,
  DriftReviewCardStore,
  SecondArrowReviewCard,
} from '../../../core/cogsec/drift/drift-review-card-store.js';
import {
  DRIFT_REVIEW_CARD_RESOLUTIONS,
  DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND,
} from '../../../core/cogsec/drift/drift-review-card-store.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';

export type { DriftReviewCard, DriftReviewCardResolution, SecondArrowReviewCard };
export { DRIFT_REVIEW_CARD_RESOLUTIONS, DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND };

export function isDriftReviewCardResolution(value: unknown): value is DriftReviewCardResolution {
  return typeof value === 'string'
    && (DRIFT_REVIEW_CARD_RESOLUTIONS as readonly string[]).includes(value);
}

export interface AdminDriftReviewListData {
  cards: DriftReviewCard[];
  openCount: number;
}

export interface AdminDriftReviewResolveRequest {
  id: string;
  resolution: DriftReviewCardResolution;
  note?: string;
}

export type AdminDriftReviewResolveResult =
  | { ok: true; card: DriftReviewCard; consolidatedMemoryIds?: string[] }
  | { ok: false; status: number; message: string };

export interface AdminDriftReviewService {
  listCards(): AdminDriftReviewListData;
  getCard(id: string): DriftReviewCard | undefined;
  resolveCard(request: AdminDriftReviewResolveRequest): Promise<AdminDriftReviewResolveResult>;
}

const GARDEN_ACTOR = 'operator:garden';

export type AdminDriftReviewServiceStore = Pick<DriftReviewCardStore, 'list' | 'getById' | 'resolve'>;

/** The existing supersession machinery the consolidation path invokes. */
export type AdminDriftConsolidationMemoryStore = Pick<
  MemoryStorePort,
  'getById' | 'updateMemory' | 'recordEvolutionLink'
>;

export function createAdminDriftReviewService(deps: {
  store: AdminDriftReviewServiceStore;
  /**
   * Null ⇒ second-arrow consolidation approvals are refused with 409
   * (cards stay evidence-only) — never a silent no-op resolve.
   */
  memoryStore?: AdminDriftConsolidationMemoryStore | null;
}): AdminDriftReviewService {
  const { store } = deps;
  const memoryStore = deps.memoryStore ?? null;

  /**
   * Applies the card's proposed supersession. Validates EVERY member against
   * the live store before mutating anything (fail closed: a stale proposal —
   * deleted canonical, member superseded elsewhere — refuses with 409 and
   * leaves the card open). Members already superseded by the canonical are
   * skipped so a retry after a partial failure converges instead of erroring.
   */
  const applyConsolidation = async (
    card: SecondArrowReviewCard,
  ): Promise<{ ok: true; consolidatedMemoryIds: string[] } | { ok: false; status: number; message: string }> => {
    if (!memoryStore) {
      return {
        ok: false,
        status: 409,
        message: 'Consolidation is unavailable on this admin surface (no memory store wired); '
          + 'the card remains open evidence',
      };
    }
    const { canonicalMemoryId, supersededMemoryIds } = card.proposedConsolidation;
    const canonical = await memoryStore.getById(canonicalMemoryId);
    if (!canonical || canonical.deletedAt || canonical.supersededBy) {
      return {
        ok: false,
        status: 409,
        message: `Canonical memory ${canonicalMemoryId} is no longer active; refusing stale consolidation`,
      };
    }
    const toSupersede: string[] = [];
    for (const memoryId of supersededMemoryIds) {
      const memory = await memoryStore.getById(memoryId);
      if (!memory) {
        return {
          ok: false,
          status: 409,
          message: `Cluster member ${memoryId} no longer exists; refusing stale consolidation`,
        };
      }
      if (memory.deletedAt) {
        return {
          ok: false,
          status: 409,
          message: `Cluster member ${memoryId} was deleted since the card was raised; refusing stale consolidation`,
        };
      }
      if (memory.supersededBy === canonicalMemoryId) continue; // already applied (retry convergence)
      if (memory.supersededBy) {
        return {
          ok: false,
          status: 409,
          message: `Cluster member ${memoryId} was superseded by ${memory.supersededBy} since the card was raised; `
            + 'refusing stale consolidation',
        };
      }
      toSupersede.push(memoryId);
    }
    for (const memoryId of toSupersede) {
      await memoryStore.updateMemory(memoryId, { supersededBy: canonicalMemoryId });
      await memoryStore.recordEvolutionLink({
        sourceMemoryId: canonicalMemoryId,
        targetMemoryId: memoryId,
        relation: 'supersedes',
        reason: `second-arrow consolidation approved by ${GARDEN_ACTOR} (drift review card ${card.id})`,
        sourceRef: `garden:drift-review:${card.id}`,
      });
    }
    return { ok: true, consolidatedMemoryIds: toSupersede };
  };

  return {
    listCards(): AdminDriftReviewListData {
      const cards = store.list();
      return {
        cards,
        openCount: cards.filter((card) => card.status === 'open').length,
      };
    },

    getCard(id: string): DriftReviewCard | undefined {
      return store.getById(id);
    },

    async resolveCard(request: AdminDriftReviewResolveRequest): Promise<AdminDriftReviewResolveResult> {
      if (!isDriftReviewCardResolution(request.resolution)) {
        return {
          ok: false,
          status: 400,
          message: `resolution must be one of: ${DRIFT_REVIEW_CARD_RESOLUTIONS.join(', ')}`,
        };
      }
      const existing = store.getById(request.id);
      if (!existing) {
        return { ok: false, status: 404, message: 'Drift review card not found' };
      }
      if (existing.status !== 'open') {
        return {
          ok: false,
          status: 409,
          message: `Drift review card is already '${existing.status}'`,
        };
      }
      if (!DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND[existing.kind].includes(request.resolution)) {
        return {
          ok: false,
          status: 400,
          message: `A '${existing.kind}' card does not accept resolution '${request.resolution}'; `
            + `allowed: ${DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND[existing.kind].join(', ')}`,
        };
      }

      let consolidatedMemoryIds: string[] | undefined;
      if (request.resolution === 'consolidated') {
        // Kind-compat check above guarantees this is a second-arrow card.
        const applied = await applyConsolidation(existing as SecondArrowReviewCard);
        if (!applied.ok) return applied;
        consolidatedMemoryIds = applied.consolidatedMemoryIds;
      }

      const card = store.resolve({
        id: request.id,
        resolution: request.resolution,
        actor: GARDEN_ACTOR,
        ...(request.note !== undefined ? { note: request.note } : {}),
      });
      return {
        ok: true,
        card,
        ...(consolidatedMemoryIds !== undefined ? { consolidatedMemoryIds } : {}),
      };
    },
  };
}
