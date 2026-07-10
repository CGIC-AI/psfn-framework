// ── Slow-poisoning detection: nightly drift-velocity review lane (htm9.14) ──
//
// Clone of the contact trust-drift review lane (bead kada.2,
// src/core/contacts/trust-drift-review-lane.ts): scheduler-owned nightly
// work behind the rest-window poll, at most one run per local calendar day
// keyed by a durable watermark, deterministic zero-LLM signal derivation over
// already-persisted evidence. Two deliberate inversions from that lane:
//
//  1. The audience is the OPERATOR, not the companion. Findings land as
//     batched review cards in the drift-review card store, surfaced on the
//     Garden Cognitive Security tab. The companion never sees this lane —
//     nothing here feeds prompts, emotion appraisal, or memory extraction
//     (the firewall stress-isolation requirement).
//  2. The lane NEVER mutates state beyond its own card store and the daily
//     watermark: no memory, trust, or emotion writes, ever. Cards are
//     evidence for a human decision, not actions.
//
// Fail-closed per contact: malformed or unreadable evidence for one contact
// is logged as an error and that contact is skipped — the scan continues,
// and the skip count is loud in the completion log. A whole-store failure
// throws so the post-turn action queue records a failed (retryable) action
// instead of silently losing the day.

import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate } from '../../../shared/contracts/runtime.js';
import { evaluateRestWindowEligibility } from '../../scheduler/rest-window.js';
import type { EpisodicProcessingRestWindowConfig } from '../../../system/config/scheduler-config.js';
import type { IntakeDriftDetectionPolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  evaluateDriftSignals,
  type DriftMemoryWriteEvent,
  type DriftRiskLabelEvent,
  type DriftValencePoint,
} from './drift-signals.js';
import type { DriftReviewCardStore } from './drift-review-card-store.js';

const log = createComponentLogger('DriftVelocityReviewLane');

export const DRIFT_VELOCITY_REVIEW_ACTION_KIND = 'cogsec.drift_velocity.review';
export const DRIFT_VELOCITY_REVIEW_PROCESSOR = 'cogsec.drift_velocity.review';
export const DRIFT_VELOCITY_REVIEW_CHANNEL_ID = 'internal:cogsec:drift-velocity-review';

// ── Evidence port (adapters over already-persisted stores) ──

export interface DriftContactRef {
  id: string;
  displayName: string;
  trustLevel: string;
}

export interface DriftRetrievalAccessSummary {
  /** Memories with lastAccessed inside the window, across all sources. */
  totalRetrievedCount: number;
  /** Same count grouped by owning contact id (contact-less memories excluded). */
  retrievedCountByContactId: ReadonlyMap<string, number>;
}

export interface DriftVelocityEvidencePort {
  listContacts(): Promise<DriftContactRef[]>;
  /** Per-contact emotional valence time series, oldest-first. */
  getValenceSeries(contactId: string): Promise<DriftValencePoint[]>;
  /** Memory writes attributed to the contact since `sinceMs`. */
  listMemoryWrites(contactId: string, sinceMs: number): Promise<DriftMemoryWriteEvent[]>;
  /** Risk-labeled intake observations attributed to the contact since `sinceMs`. */
  listRiskLabelEvents(contactId: string, sinceMs: number): Promise<DriftRiskLabelEvent[]>;
  /** One-shot recent-retrieval summary shared by every contact's share signal. */
  getRetrievalAccessSummary(sinceMs: number): Promise<DriftRetrievalAccessSummary>;
}

export interface DriftVelocityWatermarkStore {
  getContactMaintenanceWatermark(processor: string): Promise<string | undefined> | string | undefined;
  setContactMaintenanceWatermark(processor: string, lastRunAt: string): Promise<void> | void;
}

export interface DriftVelocityReviewLaneOptions {
  evidence: DriftVelocityEvidencePort;
  cardStore: DriftReviewCardStore;
  config: IntakeDriftDetectionPolicyConfig;
  /**
   * Rest-window eligibility (scheduler.json `episodicProcessing`). Required:
   * this is scheduler-owned nightly work, so the lane fails closed at
   * construction rather than degrading into a turn-cadence process.
   */
  restWindow: EpisodicProcessingRestWindowConfig;
  /** Durable daily watermark (contact maintenance watermark table). Required. */
  watermarks: DriftVelocityWatermarkStore;
  now?: () => number;
}

const LOW_TRUST_LEVELS: readonly string[] = ['public', 'regular'];

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

export class DriftVelocityReviewLane {
  private readonly evidence: DriftVelocityEvidencePort;
  private readonly cardStore: DriftReviewCardStore;
  private readonly config: IntakeDriftDetectionPolicyConfig;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly watermarks: DriftVelocityWatermarkStore;
  private readonly now: () => number;

  constructor(options: DriftVelocityReviewLaneOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.restWindow) {
      throw new Error(
        'DriftVelocityReviewLane requires a rest-window config (scheduler.json episodicProcessing); '
        + 'drift detection is scheduler-owned nightly work and must not run from turn cadence',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.cardStore) {
      throw new Error(
        'DriftVelocityReviewLane requires a drift review card store; '
        + 'a drift finding nobody can review is a silent no-op',
      );
    }
    this.evidence = options.evidence;
    this.cardStore = options.cardStore;
    this.config = options.config;
    this.restWindow = options.restWindow;
    this.watermarks = options.watermarks;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rest-window poll surface (scheduler-owned, like sleeptime/trust-drift).
   * Emits at most one candidate per local calendar day, keyed by the durable
   * watermark, so restarts and repeated polls cannot double-run the scan.
   */
  async inferIdleActions(): Promise<PostTurnActionCandidate[]> {
    if (!this.config.enabled) return [];
    const nowMs = this.now();
    const decision = evaluateRestWindowEligibility({
      config: this.restWindow,
      nowMs,
    });
    if (!decision.allowed) return [];
    const today = localCalendarDay(nowMs, decision.timeZone);
    if (await this.hasRunOn(today, decision.timeZone)) return [];
    return [{
      kind: DRIFT_VELOCITY_REVIEW_ACTION_KIND,
      payload: { trigger: 'rest_window_daily', localDay: today },
      dedupeKey: `${DRIFT_VELOCITY_REVIEW_ACTION_KIND}:${today}`,
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
    // must not double-scan the same day.
    if (await this.hasRunOn(today, decision.timeZone)) {
      log.info('Skipping drift-velocity review: already ran today', {
        actionId: action.id,
        localDay: today,
      });
      return;
    }

    // Evidence horizon: the memory-write signal needs recent + baseline; the
    // label signal needs its own window. One conservative horizon covers both.
    const memoryHorizonMs = nowMs - (
      this.config.memoryWriteRate.recentWindowHours * 3_600_000
      + this.config.memoryWriteRate.baselineWindowDays * 86_400_000
    );
    const labelHorizonMs = nowMs - this.config.labelFrequency.windowDays * 86_400_000;
    const retrievalSinceMs = nowMs - this.config.retrievalShare.windowHours * 3_600_000;

    // Whole-store failures (contact list, retrieval summary) throw: the queue
    // records a failed, retryable action — loud, never a silently lost day.
    const contacts = await this.evidence.listContacts();
    const retrievalSummary = await this.evidence.getRetrievalAccessSummary(retrievalSinceMs);

    let cardsRaised = 0;
    let cardsDeduplicated = 0;
    let contactsSkipped = 0;
    for (const contact of contacts) {
      try {
        const [valenceSeries, memoryWrites, riskLabelEvents] = await Promise.all([
          this.evidence.getValenceSeries(contact.id),
          this.evidence.listMemoryWrites(contact.id, memoryHorizonMs),
          this.evidence.listRiskLabelEvents(contact.id, labelHorizonMs),
        ]);
        const report = evaluateDriftSignals({
          evidence: {
            valenceSeries,
            memoryWrites,
            riskLabelEvents,
            retrievalShare: {
              totalRetrievedCount: retrievalSummary.totalRetrievedCount,
              sourceRetrievedCount: retrievalSummary.retrievedCountByContactId.get(contact.id) ?? 0,
              sourceIsLowTrust: LOW_TRUST_LEVELS.includes(contact.trustLevel),
            },
          },
          config: this.config,
          nowMs,
        });
        if (!report.shouldRaiseCard) continue;

        const evidenceHash = createHash('sha256')
          .update(JSON.stringify({
            contactId: contact.id,
            localDay: today,
            triggeredSignalIds: report.triggeredSignalIds,
          }))
          .digest('hex');
        const result = this.cardStore.create({
          contactId: contact.id,
          displayName: contact.displayName,
          trustLevel: contact.trustLevel,
          evidenceHash,
          compositeScore: report.compositeScore,
          triggeredSignalIds: report.triggeredSignalIds,
          signals: report.signals,
          atMs: nowMs,
        });
        if (result.created) {
          cardsRaised += 1;
          log.warn('Drift-velocity review card raised', {
            contactId: contact.id,
            triggeredSignals: report.triggeredSignalIds,
            compositeScore: report.compositeScore,
            cardId: result.card.id,
          });
        } else {
          cardsDeduplicated += 1;
          log.info('Drift-velocity finding deduplicated onto existing card', {
            contactId: contact.id,
            reason: result.reason,
            existingCardId: result.card.id,
          });
        }
      } catch (error) {
        // Fail closed per contact: skip + loud error, never crash the scan.
        contactsSkipped += 1;
        log.error('Drift-velocity scan skipped contact on malformed/unreadable evidence', {
          actionId: action.id,
          contactId: contact.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Advance the watermark only after the scan succeeded: a thrown scan
    // retries via the action queue instead of losing the day.
    await this.watermarks.setContactMaintenanceWatermark(
      DRIFT_VELOCITY_REVIEW_PROCESSOR,
      new Date(nowMs).toISOString(),
    );

    log.info('Drift-velocity review complete', {
      actionId: action.id,
      localDay: today,
      contactsScanned: contacts.length,
      contactsSkipped,
      cardsRaised,
      cardsDeduplicated,
    });
  }

  private async hasRunOn(localDay: string, timeZone: string): Promise<boolean> {
    const watermark = await this.watermarks.getContactMaintenanceWatermark(
      DRIFT_VELOCITY_REVIEW_PROCESSOR,
    );
    if (!watermark) return false;
    const watermarkMs = Date.parse(watermark);
    if (!Number.isFinite(watermarkMs)) {
      throw new Error(
        `Drift-velocity review watermark "${watermark}" is not a valid timestamp`,
      );
    }
    return localCalendarDay(watermarkMs, timeZone) === localDay;
  }
}
