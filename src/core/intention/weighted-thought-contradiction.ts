// ── "Said fine but signals disagree" contradiction dampening (Charter Law 27 / 6.24) ──
//
// Charter 6.24: «"said fine but context suggests otherwise" should reduce weight
// rather than zero it out». The pure lifecycle math for this lives in
// `applyContradictionDampening` (weighted-thoughts.ts); this module is the
// PRODUCTION detector + wiring that computes the contradiction condition from a
// real signal and invokes that math on the live weighted-thought store.
//
// The signal source is concern resolution (concern-resolution-appraisal.ts):
// when a care concern about a contact resolves, the resolving path snapshots the
// live emotional VAD (resolutionVAD) alongside the formation snapshot. A concern
// that resolves ("the person indicated it's handled / said fine") while the
// resolution VAD still reads non-positive valence with no genuine relief is the
// charter's "said fine but context suggests otherwise": the surface closure and
// the affective signals disagree. We do not drop that contact's remaining care
// thoughts to zero — we dampen them (reduce, keep a residual) so they defer yet
// can re-accumulate.
//
// No fabrication (charter 8.3): when either VAD snapshot is absent the condition
// is not met and nothing is dampened. Absence is never treated as a contradiction.

import { createComponentLogger } from '../../shared/logger.js';
import type { ActiveConcernVAD } from '../../shared/contracts/intention-contracts.js';
import type { ConcernResolutionAppraisalEvent } from './concern-resolution-appraisal.js';
import type { ActiveConcern } from './concerns.js';
import {
  applyContradictionDampening,
  type WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';
import type { WeightedThoughtStorePort } from './weighted-thought-store-port.js';

/**
 * Resolution valence at or below this ceiling counts as "signals still say not
 * okay". Default 0 (non-positive): the person's surface closure is contradicted
 * only when the observed affect failed to reach positive valence.
 */
export const DEFAULT_CONTRADICTION_VALENCE_CEILING = 0;

export interface SaidFineContradictionInput {
  formationVad?: ActiveConcernVAD;
  resolutionVad?: ActiveConcernVAD;
}

/**
 * "Said fine but context suggests otherwise." True when BOTH VAD snapshots exist
 * (never fabricated), the resolution valence stayed at/below `valenceCeiling`
 * (signals still negative), AND there was no genuine relief (valence did not
 * rise from formation to resolution). Pure — no I/O, no clock.
 */
export function detectSaidFineContradiction(
  input: SaidFineContradictionInput,
  valenceCeiling: number = DEFAULT_CONTRADICTION_VALENCE_CEILING,
): boolean {
  const { formationVad, resolutionVad } = input;
  if (!formationVad || !resolutionVad) return false;
  const reliefDelta = resolutionVad.valence - formationVad.valence;
  return resolutionVad.valence <= valenceCeiling && reliefDelta <= 0;
}

export interface WeightedThoughtContradictionDamperDeps {
  concernStore: { getById(id: string): Promise<ActiveConcern | null> | ActiveConcern | null };
  thoughtStore: Pick<WeightedThoughtStorePort, 'list' | 'save'>;
  lifecycleConfig: WeightedThoughtLifecycleConfig;
  /** Override the resolution-valence ceiling; defaults to non-positive (0). */
  valenceCeiling?: number;
  now?: () => number;
  logger?: Pick<ReturnType<typeof createComponentLogger>, 'warn' | 'debug'>;
}

export interface WeightedThoughtContradictionDampenResult {
  concernId: string;
  contactId?: string;
  contradiction: boolean;
  dampenedThoughtIds: string[];
}

/**
 * Apply "said fine but signals disagree" contradiction dampening to a resolving
 * concern's contact. Re-reads the concern (the authoritative source of contactId
 * and the VAD pair), computes the detector, and — when it fires — dampens every
 * ACTIVE weighted thought scoped to that contact via `applyContradictionDampening`
 * (reduce, never zero). Returns what happened for telemetry/tests.
 *
 * A vanished or superseded concern is skipped (resolution persistence, not this
 * enrichment, is the source of truth). Contact-less concerns and contact-less
 * thoughts are never touched — dampening is strictly contact-scoped so an
 * unrelated global thought is never reduced.
 */
export async function applyWeightedThoughtContradictionDampening(
  deps: WeightedThoughtContradictionDamperDeps,
  event: ConcernResolutionAppraisalEvent,
): Promise<WeightedThoughtContradictionDampenResult> {
  const log = deps.logger ?? createComponentLogger('WeightedThoughtContradiction');
  const now = deps.now ?? Date.now;
  const empty: WeightedThoughtContradictionDampenResult = {
    concernId: event.concernId,
    contradiction: false,
    dampenedThoughtIds: [],
  };

  const concern = await deps.concernStore.getById(event.concernId);
  if (!concern) {
    log.warn('Contradiction dampening skipped: resolved concern not found', {
      concernId: event.concernId,
      source: event.source,
    });
    return empty;
  }
  if (concern.resolutionGenerationId !== event.resolutionGenerationId) {
    log.debug('Contradiction dampening skipped: resolution generation is no longer current', {
      concernId: event.concernId,
    });
    return empty;
  }
  const contactId = concern.contactId;
  if (!contactId) {
    return empty;
  }
  const contradiction = detectSaidFineContradiction(
    { ...(concern.formationVAD ? { formationVad: concern.formationVAD } : {}), ...(concern.resolutionVAD ? { resolutionVad: concern.resolutionVAD } : {}) },
    deps.valenceCeiling ?? DEFAULT_CONTRADICTION_VALENCE_CEILING,
  );
  if (!contradiction) {
    return { ...empty, contactId };
  }

  const nowMs = now();
  const thoughts = await deps.thoughtStore.list({ contactId, activeOnly: true });
  const dampenedThoughtIds: string[] = [];
  for (const thought of thoughts) {
    // Strict contact scope: never dampen a contact-less (global) thought.
    if (thought.contactId !== contactId) continue;
    const dampened = applyContradictionDampening(thought, deps.lifecycleConfig, nowMs);
    await deps.thoughtStore.save(dampened);
    dampenedThoughtIds.push(thought.id);
  }
  if (dampenedThoughtIds.length > 0) {
    log.debug('Applied said-fine contradiction dampening to contact weighted thoughts', {
      concernId: event.concernId,
      contactId,
      dampenedCount: dampenedThoughtIds.length,
    });
  }
  return { concernId: event.concernId, contactId, contradiction: true, dampenedThoughtIds };
}

/**
 * Build the `intention.concern.resolution_appraisal` subscriber that applies
 * contradiction dampening in production. Wire the returned handler onto
 * `eventBus.on('intention.concern.resolution_appraisal', …)` — it mirrors the
 * concern-resolution arc recorder's registration shape.
 */
export function createWeightedThoughtContradictionDamper(
  deps: WeightedThoughtContradictionDamperDeps,
): (event: ConcernResolutionAppraisalEvent) => Promise<void> {
  return async (event: ConcernResolutionAppraisalEvent): Promise<void> => {
    await applyWeightedThoughtContradictionDampening(deps, event);
  };
}
