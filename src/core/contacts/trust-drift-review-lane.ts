import { createComponentLogger } from '../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import type {
  DyadRelationshipAdvisory,
  DyadRelationshipAdvisoryProvider,
} from '../../shared/contracts/dyad-relationship-advisory.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { evaluateRestWindowEligibility } from '../scheduler/rest-window.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import type { ContactStorePort } from './contact-store-port.js';
import {
  evaluateContactRelationshipProgressionCandidate,
  evaluateContactTrustDriftCandidate,
  type ContactRelationshipProgressionReviewCandidate,
  type ContactTrustDriftReviewCandidate,
} from './trust-drift-signals.js';

const log = createComponentLogger('ContactTrustDriftReviewLane');

// ── Nightly contact trust + relationship review lane (bead kada.2, usye) ──
//
// Scheduler-owned nightly work, following the sleeptime pattern: a rest-window
// poll infers at most one action per local calendar day; the executor derives
// TrustDriftBehaviorSignals per contact from recorded evidence and evaluates
// the independent trust and relationship axes. Trust suggestions render first,
// but a gated/unchanged trust axis never suppresses relationship progression.
// The lane NEVER mutates either field: applying (or declining) a suggestion
// stays the companion's decision through the guarded `contact` actions. Its
// only write is the daily watermark. Existing constant/class names remain for
// compatibility with the scheduler wiring and durable watermark.

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
  /**
   * Optional read-only advisory over the emo_sim affect model's directed
   * relationship reading. Purely advisory context the companion weighs — it
   * never mutates trust or relationship state (the review store surface here
   * has no mutators). Absent/unavailable/no-data degrades to omission; an
   * infrastructure failure is logged and the review still delivers without it.
   */
  dyadAdvisoryProvider?: DyadRelationshipAdvisoryProvider | null;
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

function formatSignalsJson(
  candidate: ContactTrustDriftReviewCandidate | ContactRelationshipProgressionReviewCandidate,
): string {
  return JSON.stringify({
    positiveInteractionCount: candidate.signals.positiveInteractionCount,
    negativeInteractionCount: candidate.signals.negativeInteractionCount ?? 0,
    verifiedIdentityLinks: candidate.signals.verifiedIdentityLinks ?? 0,
    consistentBoundaryRespect: candidate.signals.consistentBoundaryRespect !== false,
  });
}

export function composeTrustDriftReviewContent(
  trustCandidates: readonly ContactTrustDriftReviewCandidate[],
  relationshipCandidates: readonly ContactRelationshipProgressionReviewCandidate[] = [],
  dyadAdvisory: DyadRelationshipAdvisory | null = null,
): string {
  const lines: string[] = [
    'Daily contact trust and relationship review. The nightly scan derived behavior signals',
    'from your recorded interaction history and evaluated both independent classifications.',
    'Nothing has been changed: each one is yours to apply or decline.',
  ];
  if (trustCandidates.length > 0) {
    lines.push('', 'Trust suggestions (higher-priority disclosure axis):');
    trustCandidates.forEach((candidate, index) => {
      lines.push(
        `${index + 1}. ${candidate.displayName} (contactId: ${candidate.contactId}) — Trust: `
        + `${candidate.suggestion.fromTrustLevel} -> ${candidate.suggestion.suggestedTrustLevel} `
        + `(confidence ${candidate.suggestion.confidence})`,
        `   Rationale: ${candidate.suggestion.rationale}`,
        `   Signals: ${formatSignalsJson(candidate)}`,
      );
    });
    lines.push(
      'To apply a trust suggestion: call `contact` with action=set_trust, contactId, the Signals',
      'as behaviorSignals, and confirmSuggestion=true.',
    );
  }
  if (relationshipCandidates.length > 0) {
    lines.push('', 'Relationship suggestions (separate from trust):');
    relationshipCandidates.forEach((candidate, index) => {
      const action = candidate.suggestion.requiresApproval
        ? 'propose_relationship'
        : 'set_relationship';
      lines.push(
        `${index + 1}. ${candidate.displayName} (contactId: ${candidate.contactId}) — Relationship: `
        + `${candidate.suggestion.fromRelationshipType} -> ${candidate.suggestion.suggestedRelationshipType}`,
        `   Rationale: ${candidate.suggestion.rationale}`,
        `   Signals: ${formatSignalsJson(candidate)}`,
        `   Apply with action=${action}, relationshipType=${candidate.suggestion.suggestedRelationshipType}, `
        + `and contactId${candidate.suggestion.requiresApproval
          ? '; include a rationale and wait for operator approval'
          : ''}.`,
      );
    });
  }
  if (dyadAdvisory) {
    lines.push(
      '',
      'Background relational read (advisory only — inferred by the emo_sim affect model from your',
      'recent interactions, not a self-report; it changes nothing and is not a reason to move anyone',
      'by itself):',
      `   ${dyadAdvisory.prose}`,
      '   Weigh it as one more signal alongside your own judgment.',
    );
  }
  lines.push(
    '',
    'To hold any suggestion, do nothing; the scan can surface it again while evidence supports it.',
    'Trusted/primary trust changes and family/partner relationships remain operator-gated.',
  );
  return lines.join('\n');
}

export class ContactTrustDriftReviewLane {
  private readonly contactStore: ContactTrustDriftReviewStore;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly deliverReview: (review: ContactTrustDriftReviewDelivery) => void;
  private readonly dyadAdvisoryProvider: DyadRelationshipAdvisoryProvider | null;
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
    this.dyadAdvisoryProvider = options.dyadAdvisoryProvider ?? null;
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
    const trustCandidates: ContactTrustDriftReviewCandidate[] = [];
    const relationshipCandidates: ContactRelationshipProgressionReviewCandidate[] = [];
    for (const contact of contacts) {
      const timeSeries = await this.contactStore.getEmotionalTimeSeries(contact.id, SIGNAL_TIME_SERIES_LIMIT);
      const verifiedIdentityLinkCount = await this.contactStore.countVerifiedIdentityLinks(contact.id);
      const evidence = { timeSeries, verifiedIdentityLinkCount };
      const trustCandidate = evaluateContactTrustDriftCandidate({
        contact,
        evidence,
      });
      if (trustCandidate) trustCandidates.push(trustCandidate);
      const relationshipCandidate = evaluateContactRelationshipProgressionCandidate({
        contact,
        evidence,
      });
      if (relationshipCandidate) relationshipCandidates.push(relationshipCandidate);
    }

    if (trustCandidates.length > 0 || relationshipCandidates.length > 0) {
      const candidateContactIds = new Set([
        ...trustCandidates.map(candidate => candidate.contactId),
        ...relationshipCandidates.map(candidate => candidate.contactId),
      ]);
      // Advisory context only. Fail SOFT at the companion boundary: a missing
      // provider, no data, or an infrastructure failure all omit the signal
      // rather than blocking or breaking the review. The provider already logs
      // (and throws) infrastructure failures; we log the resulting omission so
      // no degradation is silent.
      const dyadAdvisory = await this.resolveDyadAdvisory(action.id);
      this.deliverReview({
        content: composeTrustDriftReviewContent(trustCandidates, relationshipCandidates, dyadAdvisory),
        candidateCount: candidateContactIds.size,
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
      trustCandidates: trustCandidates.length,
      relationshipCandidates: relationshipCandidates.length,
    });
  }

  /**
   * Read the advisory dyad reading, fail-soft. Returns null (omit the signal)
   * on no provider, no data, or any infrastructure failure — the review must
   * still deliver. Infrastructure failures are surfaced by the provider's own
   * logger and re-logged here as an explicit omission (never silently
   * swallowed). This path is read-only: it touches no trust/relationship state.
   */
  private async resolveDyadAdvisory(
    actionId: string,
  ): Promise<DyadRelationshipAdvisory | null> {
    if (!this.dyadAdvisoryProvider) return null;
    try {
      return await this.dyadAdvisoryProvider.describeLatestDirectedRelationship();
    } catch (error) {
      log.info('Omitting emo_sim dyad advisory from trust-drift review (read unavailable)', {
        actionId,
        error: toErrorMessage(error),
      });
      return null;
    }
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
