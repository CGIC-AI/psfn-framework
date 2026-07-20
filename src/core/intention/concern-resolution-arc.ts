import { createComponentLogger } from '../../shared/logger.js';
import type {
  ReflectionConcernArcSource,
  ReflectionJournalEntryInput,
} from '../../persistence/journals/reflection-journal.js';
import { describeConcernEmotionalArc } from './appraisal/concern-arc-prose.js';
import {
  buildConcernResolutionAppraisalEvent,
  computeConcernReliefDelta,
  type ConcernResolutionAppraisalEvent,
} from './concern-resolution-appraisal.js';
import type { ActiveConcern } from './concerns.js';

/**
 * Concern-resolution arc recorder (vw3w.2).
 *
 * Subscribes to the `intention.concern.resolution_appraisal` event (emitted by
 * vw3w.1 on every resolve path) and writes the emotional arc — formation VAD →
 * resolution VAD, duration carried, final salience — into the dedicated
 * concern-arc reflection journal as lived experience. This is the integration
 * half of Purrsephone's finding: resolution should integrate, not evaporate.
 *
 * Provenance: the entry is derived internal-state data, not partner speech. It
 * is attributed to the companion (`mode: 'agent'`), carries the concern id in
 * `substrateProvenanceRefs`, and stamps `substrateBoundary` so the arc is never
 * mistaken for external content.
 *
 * No fabrication (charter 8.3/8.4): the arc is written only when the resolved
 * concern carries BOTH a formation and a resolution VAD. If either is absent the
 * recorder writes nothing — it never invents a feeling that was not captured.
 * The emitter already guards on both VADs; this recorder re-checks the persisted
 * concern so the invariant holds even if the two ever diverge.
 */

const ARC_TEMPLATE_ID = 'concern_arc';
const ARC_TEMPLATE_NAME = 'Concern Arc';
const ARC_CHANNEL_ID = 'internal:concern-resolution';
const ARC_SUBSTRATE_BOUNDARY = 'concern-resolution-arc';
const ARC_PROMPT_MAX_CHARS = 200;

export interface ConcernArcJournalSink {
  hasEntry(id: string): boolean;
  appendOnce(id: string, input: ReflectionJournalEntryInput): unknown;
}

export interface ConcernResolutionEmotionSink {
  applyConcernResolutionDelta(
    concern: ActiveConcern,
    generationId: string,
    delta: ConcernResolutionAppraisalEvent['reliefDelta'],
  ): 'applied' | 'duplicate' | 'deferred' | 'unavailable'
    | Promise<'applied' | 'duplicate' | 'deferred' | 'unavailable'>;
}

export interface ConcernArcConcernSource {
  getById(id: string): Promise<ActiveConcern | null> | ActiveConcern | null;
}

function resolveDurationMs(concern: Pick<ActiveConcern, 'createdAt' | 'resolvedAt'>): number | undefined {
  if (!concern.resolvedAt) return undefined;
  const created = Date.parse(concern.createdAt);
  const resolved = Date.parse(concern.resolvedAt);
  if (!Number.isFinite(created) || !Number.isFinite(resolved)) return undefined;
  const delta = resolved - created;
  return delta >= 0 ? delta : undefined;
}

function truncateConcernText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= ARC_PROMPT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, ARC_PROMPT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Build the journal entry for a resolved concern's arc, or null when the arc is
 * incomplete (missing either VAD snapshot). Pure — no I/O.
 */
export function buildConcernResolutionArcEntry(input: {
  concern: Pick<ActiveConcern, 'id' | 'text' | 'salience' | 'createdAt' | 'resolvedAt' | 'formationVAD' | 'resolutionVAD' | 'resolutionGenerationId'>;
  source: ReflectionConcernArcSource;
  now?: () => number;
}): ReflectionJournalEntryInput | null {
  const { concern, source } = input;
  const { formationVAD, resolutionVAD } = concern;
  if (!formationVAD || !resolutionVAD || !concern.resolutionGenerationId) {
    return null;
  }
  const arcProse = describeConcernEmotionalArc({ formationVAD, resolutionVAD });
  if (!arcProse) {
    return null;
  }
  const durationMs = resolveDurationMs(concern);
  const finalSalience = Number.isFinite(concern.salience) ? concern.salience : undefined;
  const createdAt = concern.resolvedAt ?? new Date((input.now ?? Date.now)()).toISOString();
  const promptText = truncateConcernText(concern.text);
  return {
    templateId: ARC_TEMPLATE_ID,
    templateName: ARC_TEMPLATE_NAME,
    prompt: promptText.length > 0 ? `Resolved concern: ${promptText}` : 'Resolved concern',
    reflection: arcProse,
    channelId: ARC_CHANNEL_ID,
    mode: 'agent',
    createdAt,
    substrateBoundary: ARC_SUBSTRATE_BOUNDARY,
    substrateProvenanceRefs: [`concern:${concern.id}`],
    concernArc: {
      concernId: concern.id,
      resolutionGenerationId: concern.resolutionGenerationId,
      formationVAD: { ...formationVAD },
      resolutionVAD: { ...resolutionVAD },
      reliefDelta: computeConcernReliefDelta(formationVAD, resolutionVAD),
      source,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(finalSalience !== undefined ? { finalSalience } : {}),
    },
  };
}

export interface ConcernResolutionArcRecorderDeps {
  concernStore: ConcernArcConcernSource;
  journal: ConcernArcJournalSink;
  emotionSink?: ConcernResolutionEmotionSink;
  now?: () => number;
  logger?: Pick<ReturnType<typeof createComponentLogger>, 'warn' | 'debug'>;
}

/**
 * Create the event handler that records a concern-resolution arc. Wire the
 * returned handler onto `eventBus.on('intention.concern.resolution_appraisal', …)`.
 *
 * The handler re-reads the resolved concern (the persisted source of truth for
 * createdAt/salience/text and the authoritative VAD pair). A vanished concern is
 * logged and skipped — resolution persistence, not the journal, is the source of
 * truth, so a missing enrichment record must not throw. Genuine journal write
 * failures are NOT swallowed: they propagate to the event bus, which logs them.
 */
export function createConcernResolutionArcRecorder(
  deps: ConcernResolutionArcRecorderDeps,
): (event: ConcernResolutionAppraisalEvent) => Promise<void> {
  const log = deps.logger ?? createComponentLogger('ConcernResolutionArc');
  return async (event: ConcernResolutionAppraisalEvent): Promise<void> => {
    const concern = await deps.concernStore.getById(event.concernId);
    if (!concern) {
      log.warn('Concern resolution arc skipped: resolved concern not found', {
        concernId: event.concernId,
        source: event.source,
      });
      return;
    }
    if (concern.resolutionGenerationId !== event.resolutionGenerationId) {
      log.warn('Concern resolution arc skipped: resolution generation is no longer current', {
        concernId: event.concernId,
        source: event.source,
      });
      return;
    }
    const journalEntryId = `concern-arc-${event.resolutionGenerationId}`;
    if (deps.journal.hasEntry(journalEntryId)) return;
    const entry = buildConcernResolutionArcEntry({
      concern,
      source: event.source,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (!entry) {
      log.debug('Concern resolution arc skipped: incomplete VAD arc', {
        concernId: event.concernId,
        source: event.source,
      });
      return;
    }
    await deps.emotionSink?.applyConcernResolutionDelta(
      concern,
      event.resolutionGenerationId,
      event.reliefDelta,
    );
    await deps.journal.appendOnce(journalEntryId, entry);
    log.debug('Recorded concern resolution arc', {
      concernId: event.concernId,
      source: event.source,
    });
  };
}

/** Replay persisted terminal generations that never reached the durable arc. */
export async function reconcileConcernResolutionArcs(input: {
  concernStore: ConcernArcConcernSource & {
    list(options: {
      includeResolved: boolean;
      includeExpired: boolean;
      limit: number;
      offset: number;
    }): Promise<ActiveConcern[]>;
  };
  recorder: (event: ConcernResolutionAppraisalEvent) => Promise<void>;
  now?: () => number;
}): Promise<number> {
  let reconciled = 0;
  let offset = 0;
  for (;;) {
    const concerns = await input.concernStore.list({
      includeResolved: true,
      includeExpired: true,
      limit: 200,
      offset,
    });
    for (const concern of concerns) {
      const event = buildConcernResolutionAppraisalEvent({
        concern,
        source: resolveReconciledArcSource(concern),
        ...(input.now ? { now: input.now } : {}),
      });
      if (!event) continue;
      await input.recorder(event);
      reconciled += 1;
    }
    if (concerns.length < 200) break;
    offset += concerns.length;
  }
  return reconciled;
}

function resolveReconciledArcSource(concern: ActiveConcern): ReflectionConcernArcSource {
  const refs = concern.resolutionEvidenceRefs.map(ref => ref.ref);
  if (refs.some(ref => ref.startsWith('concern-grooming:stale:'))) return 'grooming_stale';
  if (refs.some(ref => ref.startsWith('concern-grooming:cap:'))) return 'grooming_cap';
  return 'decision';
}
