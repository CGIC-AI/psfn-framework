import { createComponentLogger } from '../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import { evaluateRestWindowEligibility } from '../scheduler/rest-window.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import type { ContactStorePort } from './contact-store-port.js';
import {
  evaluateContactTrustDriftCandidate,
  type ContactTrustDriftReviewCandidate,
} from './trust-drift-signals.js';

const log = createComponentLogger('ContactTrustDriftReviewLane');

// ── Nightly contact trust-drift review lane (bead kada.2) ──
//
// Scheduler-owned nightly work, following the sleeptime pattern: a rest-window
// poll infers at most one action per local calendar day; the executor derives
// TrustDriftBehaviorSignals per low-tier contact from recorded evidence and,
// when the drift evaluator produces suggestions, delivers a review to the
// companion. The lane NEVER mutates trust: applying (or declining) a suggested
// drift stays the companion's decision through the existing guarded
// `contact` tool set_trust drift path. Its only write is the daily watermark.

export const CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND = 'contacts.trust_drift.review';
export const CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR = 'contacts.trust_drift.review';
export const CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID = 'internal:reflection:contact-drift-review';

const SIGNAL_TIME_SERIES_LIMIT = 64;

export type ContactTrustDriftReviewStore = Pick<
  ContactStorePort,
  | 'listAll'
  | 'getEmotionalTimeSeries'
  | 'countVerifiedIdentityLinks'
  | 'getContactMaintenanceWatermark'
  | 'setContactMaintenanceWatermark'
>;

export interface ContactTrustDriftReviewDelivery {
  content: string;
  candidateCount: number;
}

export interface ContactTrustDriftReviewLaneOptions {
  contactStore: ContactTrustDriftReviewStore;
  /**
   * Rest-window eligibility (scheduler.json `episodicProcessing`). Required:
   * this is scheduler-owned nightly work, so the lane fails closed at
   * construction rather than degrading into a turn-cadence process.
   */
  restWindow: EpisodicProcessingRestWindowConfig;
  /** Delivers the composed review to the companion (heartbeat followUp). Required. */
  deliverReview: (review: ContactTrustDriftReviewDelivery) => void;
  now?: () => number;
}

function localCalendarDay(epochMs: number, timeZone: string): string {
  // en-CA yields YYYY-MM-DD; an invalid configured zone throws (fail closed)
  // exactly like the rest-window evaluator does for the same config field.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(epochMs);
}

function formatSignalsJson(candidate: ContactTrustDriftReviewCandidate): string {
  return JSON.stringify({
    positiveInteractionCount: candidate.signals.positiveInteractionCount,
    negativeInteractionCount: candidate.signals.negativeInteractionCount ?? 0,
    verifiedIdentityLinks: candidate.signals.verifiedIdentityLinks ?? 0,
    consistentBoundaryRespect: candidate.signals.consistentBoundaryRespect !== false,
  });
}

export function composeTrustDriftReviewContent(
  candidates: readonly ContactTrustDriftReviewCandidate[],
): string {
  const lines: string[] = [
    'Daily contact trust review. The nightly scan derived behavior signals from your recorded',
    'interaction history and the trust policy produced these low-tier drift suggestions.',
    'Nothing has been changed: each one is yours to apply or decline.',
    '',
  ];
  candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. ${candidate.displayName} (contactId: ${candidate.contactId}) — `
      + `${candidate.suggestion.fromTrustLevel} -> ${candidate.suggestion.suggestedTrustLevel} `
      + `(confidence ${candidate.suggestion.confidence})`,
      `   Rationale: ${candidate.suggestion.rationale}`,
      `   Signals: ${formatSignalsJson(candidate)}`,
    );
  });
  lines.push(
    '',
    'To apply one: call the `contact` tool with action=set_trust, the contactId, the Signals',
    'JSON above as behaviorSignals, and confirmSuggestion=true. To hold, do nothing — the',
    'scan will surface it again while the evidence still supports it. High-tier changes',
    '(trusted/primary) are not part of this review and still require operator approval.',
  );
  return lines.join('\n');
}

export class ContactTrustDriftReviewLane {
  private readonly contactStore: ContactTrustDriftReviewStore;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly deliverReview: (review: ContactTrustDriftReviewDelivery) => void;
  private readonly now: () => number;

  constructor(options: ContactTrustDriftReviewLaneOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.restWindow) {
      throw new Error(
        'ContactTrustDriftReviewLane requires a rest-window config (scheduler.json episodicProcessing); '
        + 'the trust-drift review is scheduler-owned nightly work and must not run from turn cadence',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.deliverReview) {
      throw new Error(
        'ContactTrustDriftReviewLane requires a deliverReview hook; '
        + 'a review nobody receives is a silent no-op',
      );
    }
    this.contactStore = options.contactStore;
    this.restWindow = options.restWindow;
    this.deliverReview = options.deliverReview;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rest-window poll surface (scheduler-owned, like sleeptime). Emits at most
   * one candidate per local calendar day, keyed by the durable watermark, so
   * restarts and repeated polls inside the window cannot double-run the review.
   */
  async inferIdleActions(): Promise<PostTurnActionCandidate[]> {
    const nowMs = this.now();
    const decision = evaluateRestWindowEligibility({
      config: this.restWindow,
      nowMs,
    });
    if (!decision.allowed) return [];
    const today = localCalendarDay(nowMs, decision.timeZone);
    if (await this.hasRunOn(today, decision.timeZone)) return [];
    return [{
      kind: CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
      payload: { trigger: 'rest_window_daily', localDay: today },
      dedupeKey: `${CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND}:${today}`,
      maxRetries: 1,
    }];
  }

  async execute(action: Pick<InferredPostTurnAction, 'id' | 'payload'>): Promise<void> {
    const nowMs = this.now();
    const decision = evaluateRestWindowEligibility({
      config: this.restWindow,
      nowMs,
    });
    const today = localCalendarDay(nowMs, decision.timeZone);
    // Re-check under the executor: a queued duplicate (retry, restart replay)
    // must not deliver the same review twice in one day.
    if (await this.hasRunOn(today, decision.timeZone)) {
      log.info('Skipping contact trust-drift review: already ran today', {
        actionId: action.id,
        localDay: today,
      });
      return;
    }

    const contacts = await this.contactStore.listAll();
    const candidates: ContactTrustDriftReviewCandidate[] = [];
    for (const contact of contacts) {
      if (contact.trustLevel !== 'public' && contact.trustLevel !== 'regular') continue;
      const timeSeries = await this.contactStore.getEmotionalTimeSeries(contact.id, SIGNAL_TIME_SERIES_LIMIT);
      const verifiedIdentityLinkCount = await this.contactStore.countVerifiedIdentityLinks(contact.id);
      const candidate = evaluateContactTrustDriftCandidate({
        contact,
        evidence: { timeSeries, verifiedIdentityLinkCount },
      });
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length > 0) {
      this.deliverReview({
        content: composeTrustDriftReviewContent(candidates),
        candidateCount: candidates.length,
      });
    }

    // Advance the watermark only after the scan (and any delivery) succeeded:
    // a thrown scan retries via the action queue instead of losing the day.
    await this.contactStore.setContactMaintenanceWatermark(
      CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR,
      new Date(nowMs).toISOString(),
    );

    log.info('Contact trust-drift review complete', {
      actionId: action.id,
      localDay: today,
      contactsScanned: contacts.length,
      driftCandidates: candidates.length,
    });
  }

  private async hasRunOn(localDay: string, timeZone: string): Promise<boolean> {
    const watermark = await this.contactStore.getContactMaintenanceWatermark(
      CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR,
    );
    if (!watermark) return false;
    const watermarkMs = Date.parse(watermark);
    if (!Number.isFinite(watermarkMs)) {
      throw new Error(
        `Contact trust-drift review watermark "${watermark}" is not a valid timestamp`,
      );
    }
    return localCalendarDay(watermarkMs, timeZone) === localDay;
  }
}
