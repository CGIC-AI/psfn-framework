// ── Garden admin service: slow-poisoning drift review cards (htm9.14) ──
//
// Thin operator-capability wrapper over the drift review card store the
// nightly drift-velocity lane writes. Only reachable through the operator-
// authenticated /api/admin surface. Resolving a card records the operator
// decision (acknowledge/dismiss) on the card itself — and NOTHING else: the
// drift lane never auto-mutates memories, trust, or emotion, and neither
// does this service.

import type {
  DriftReviewCard,
  DriftReviewCardResolution,
  DriftReviewCardStore,
} from '../../../core/cogsec/drift/drift-review-card-store.js';
import { DRIFT_REVIEW_CARD_RESOLUTIONS } from '../../../core/cogsec/drift/drift-review-card-store.js';

export type { DriftReviewCard, DriftReviewCardResolution };
export { DRIFT_REVIEW_CARD_RESOLUTIONS };

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
  | { ok: true; card: DriftReviewCard }
  | { ok: false; status: number; message: string };

export interface AdminDriftReviewService {
  listCards(): AdminDriftReviewListData;
  getCard(id: string): DriftReviewCard | undefined;
  resolveCard(request: AdminDriftReviewResolveRequest): AdminDriftReviewResolveResult;
}

const GARDEN_ACTOR = 'operator:garden';

export type AdminDriftReviewServiceStore = Pick<DriftReviewCardStore, 'list' | 'getById' | 'resolve'>;

export function createAdminDriftReviewService(deps: {
  store: AdminDriftReviewServiceStore;
}): AdminDriftReviewService {
  const { store } = deps;
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

    resolveCard(request: AdminDriftReviewResolveRequest): AdminDriftReviewResolveResult {
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
      const card = store.resolve({
        id: request.id,
        resolution: request.resolution,
        actor: GARDEN_ACTOR,
        ...(request.note !== undefined ? { note: request.note } : {}),
      });
      return { ok: true, card };
    },
  };
}
