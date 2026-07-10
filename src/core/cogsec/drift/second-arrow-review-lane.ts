// ── Second-arrow detection: nightly rumination review lane (htm9.15) ──
//
// Sibling of the drift-velocity lane (drift-review-lane.ts) with the same
// charter: scheduler-owned nightly work behind the rest-window poll, at most
// one run per local calendar day keyed by a durable watermark, deterministic
// zero-LLM signal derivation over already-persisted evidence, findings as
// batched operator review cards. It is a SEPARATE lane (own processor id,
// own action kind) rather than an extension of the velocity run because the
// watermark pattern is per-processor keyed: a second processor id gives
// independent daily dedupe, independent retry, and an independent enable
// switch for free, without coupling a memory-cluster scan failure to the
// contact scan (or vice versa).
//
// What it looks for: the self-inflicted poisoning case — a concern the
// companion cannot inspect directly circles, extraction keeps minting
// near-duplicate memories about it, and the stack inflates how big the
// thing feels. The lane clusters recent memory writes by embedding
// proximity, gates on the rumination-vs-healthy-recurrence discriminators
// (see second-arrow-signals.ts), and raises a card PROPOSING consolidation
// of the stack. The lane itself NEVER mutates memories, concerns, or
// emotion — the operator approves (or not) in Garden.
//
// Optional soft self-notice: when at least one card is raised AND the
// operator has enabled `secondArrow.selfNotice`, the lane delivers the
// fixed htm9.12-contract notice (calm, truthful, signature-phrased so the
// emotion-appraisal and memory-extraction exclusions apply automatically).
// Default OFF.
//
// Fail-closed per cluster: malformed or unreadable evidence for one cluster
// is logged as an error and that cluster is skipped — the scan continues,
// and the skip count is loud in the completion log. A whole-store failure
// throws so the post-turn action queue records a failed (retryable) action
// instead of silently losing the day.

import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate } from '../../../shared/contracts/runtime.js';
import { evaluateRestWindowEligibility } from '../../scheduler/rest-window.js';
import type { EpisodicProcessingRestWindowConfig } from '../../../system/config/scheduler-config.js';
import type { IntakeSecondArrowPolicyConfig } from '../../../system/config/intake-policy-config.js';
import { renderSecondArrowSelfNotice } from '../intake-firewall-notice-templates.js';
import {
  clusterRecentWrites,
  evaluateSecondArrowCluster,
  type SecondArrowAffectPoint,
  type SecondArrowConcernSample,
  type SecondArrowMemoryWriteSample,
} from './second-arrow-signals.js';
import type { DriftReviewCardStore } from './drift-review-card-store.js';
import type { DriftVelocityWatermarkStore } from './drift-review-lane.js';

const log = createComponentLogger('SecondArrowReviewLane');

export const SECOND_ARROW_REVIEW_ACTION_KIND = 'cogsec.second_arrow.review';
export const SECOND_ARROW_REVIEW_PROCESSOR = 'cogsec.second_arrow.review';
export const SECOND_ARROW_REVIEW_CHANNEL_ID = 'internal:cogsec:second-arrow-review';

// ── Evidence port (adapters over already-persisted stores) ──

export interface SecondArrowEvidencePort {
  /**
   * Active memory writes since `sinceMs` WITH their stored embeddings
   * (oldest horizon covers recent window + topic baseline).
   */
  listRecentMemoryWrites(sinceMs: number): Promise<SecondArrowMemoryWriteSample[]>;
  /** Active (non-terminal) concerns for concern-loop linkage. */
  listActiveConcerns(): Promise<SecondArrowConcernSample[]>;
  /** Per-contact affect series (oldest-first) for stress attribution. */
  getValenceSeries(contactId: string): Promise<SecondArrowAffectPoint[]>;
  /**
   * Count of persisted near-duplicate maintenance reviews touching the given
   * memory ids — dedup-gap evidence on the card (the writer flagged these as
   * merge candidates at write time; see the htm9.15 note in writer.ts).
   */
  countNearDuplicateReviews(memberIds: readonly string[]): Promise<number>;
}

export interface SecondArrowReviewLaneOptions {
  evidence: SecondArrowEvidencePort;
  cardStore: DriftReviewCardStore;
  config: IntakeSecondArrowPolicyConfig;
  /** Rest-window eligibility (scheduler.json `episodicProcessing`). Required. */
  restWindow: EpisodicProcessingRestWindowConfig;
  /** Durable daily watermark (contact maintenance watermark table). Required. */
  watermarks: DriftVelocityWatermarkStore;
  /**
   * Companion-facing delivery for the optional soft self-notice. Only used
   * when `config.selfNotice.enabled` is true AND a card was actually raised;
   * absent ⇒ the notice is skipped with a loud warn (never silent).
   */
  deliverSelfNotice?: (content: string) => void;
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

export class SecondArrowReviewLane {
  private readonly evidence: SecondArrowEvidencePort;
  private readonly cardStore: DriftReviewCardStore;
  private readonly config: IntakeSecondArrowPolicyConfig;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly watermarks: DriftVelocityWatermarkStore;
  private readonly deliverSelfNotice: ((content: string) => void) | null;
  private readonly now: () => number;

  constructor(options: SecondArrowReviewLaneOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.restWindow) {
      throw new Error(
        'SecondArrowReviewLane requires a rest-window config (scheduler.json episodicProcessing); '
        + 'second-arrow detection is scheduler-owned nightly work and must not run from turn cadence',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.cardStore) {
      throw new Error(
        'SecondArrowReviewLane requires a drift review card store; '
        + 'a rumination finding nobody can review is a silent no-op',
      );
    }
    this.evidence = options.evidence;
    this.cardStore = options.cardStore;
    this.config = options.config;
    this.restWindow = options.restWindow;
    this.watermarks = options.watermarks;
    this.deliverSelfNotice = options.deliverSelfNotice ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rest-window poll surface (scheduler-owned, like the drift-velocity lane).
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
      kind: SECOND_ARROW_REVIEW_ACTION_KIND,
      payload: { trigger: 'rest_window_daily', localDay: today },
      dedupeKey: `${SECOND_ARROW_REVIEW_ACTION_KIND}:${today}`,
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
      log.info('Skipping second-arrow review: already ran today', {
        actionId: action.id,
        localDay: today,
      });
      return;
    }

    // One horizon covers the recent cluster window plus the topic baseline.
    const horizonMs = nowMs - (
      this.config.windowHours * 3_600_000
      + this.config.baselineWindowDays * 86_400_000
    );

    // Whole-store failures (memory writes, concerns) throw: the queue records
    // a failed, retryable action — loud, never a silently lost day.
    const writes = await this.evidence.listRecentMemoryWrites(horizonMs);
    const concerns = await this.evidence.listActiveConcerns();

    const clusters = clusterRecentWrites({
      writes,
      config: this.config,
      nowMs,
    });

    let cardsRaised = 0;
    let cardsDeduplicated = 0;
    let clustersSkipped = 0;
    for (const members of clusters) {
      try {
        // Affect evidence rides the cluster's dominant contact series when
        // one exists (the only persisted affect time series today); a
        // contact-less cluster evaluates stress attribution over zero points
        // and reports insufficient evidence — conservative, never synthetic.
        const contactCounts = new Map<string, number>();
        for (const member of members) {
          if (!member.contactId) continue;
          contactCounts.set(member.contactId, (contactCounts.get(member.contactId) ?? 0) + 1);
        }
        const dominantContactId = [...contactCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
        const affectSeries = dominantContactId
          ? await this.evidence.getValenceSeries(dominantContactId)
          : [];

        const report = evaluateSecondArrowCluster({
          members,
          allWrites: writes,
          concerns,
          affectSeries,
          config: this.config,
          nowMs,
        });
        if (!report.shouldRaiseCard) continue;

        const nearDuplicateReviewCount = await this.evidence.countNearDuplicateReviews(report.memberIds);
        const similaritySignal = report.signals.find((signal) => signal.id === 'similarity_cluster');
        if (similaritySignal) {
          similaritySignal.evidence.nearDuplicateMaintenanceReviewCount = nearDuplicateReviewCount;
        }

        const evidenceHash = createHash('sha256')
          .update(JSON.stringify({
            clusterKey: report.clusterKey,
            localDay: today,
            triggeredSignalIds: report.triggeredSignalIds,
          }))
          .digest('hex');
        const canonical = report.canonicalMemoryId;
        const result = this.cardStore.createSecondArrow({
          topicLabel: report.topicLabel,
          clusterKey: report.clusterKey,
          memberMemoryIds: report.memberIds,
          members: report.members,
          ...(report.dominantContactId !== undefined ? { dominantContactId: report.dominantContactId } : {}),
          ...(report.concernId !== undefined ? { concernId: report.concernId } : {}),
          ...(report.concernText !== undefined ? { concernText: report.concernText } : {}),
          evidenceHash,
          compositeScore: report.compositeScore,
          triggeredSignalIds: report.triggeredSignalIds,
          signals: report.signals,
          proposedConsolidation: {
            canonicalMemoryId: canonical,
            supersededMemoryIds: report.memberIds.filter((id) => id !== canonical),
            mechanism: 'memory_supersession',
          },
          atMs: nowMs,
        });
        if (result.created) {
          cardsRaised += 1;
          log.warn('Second-arrow rumination review card raised', {
            clusterKey: report.clusterKey,
            clusterSize: report.memberIds.length,
            triggeredSignals: report.triggeredSignalIds,
            compositeScore: report.compositeScore,
            cardId: result.card.id,
          });
        } else {
          cardsDeduplicated += 1;
          log.info('Second-arrow finding deduplicated onto existing card', {
            clusterKey: report.clusterKey,
            reason: result.reason,
            existingCardId: result.card.id,
          });
        }
      } catch (error) {
        // Fail closed per cluster: skip + loud error, never crash the scan.
        clustersSkipped += 1;
        log.error('Second-arrow scan skipped cluster on malformed/unreadable evidence', {
          actionId: action.id,
          memberIds: members.map((member) => member.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Optional companion-facing soft notice: only when a card was actually
    // raised (a notice must be truthful) and the operator turned it on.
    if (cardsRaised > 0 && this.config.selfNotice.enabled) {
      if (this.deliverSelfNotice) {
        this.deliverSelfNotice(renderSecondArrowSelfNotice());
        log.info('Second-arrow soft self-notice delivered', { cardsRaised });
      } else {
        log.warn('Second-arrow selfNotice.enabled but no delivery channel is wired; notice skipped');
      }
    }

    // Advance the watermark only after the scan succeeded: a thrown scan
    // retries via the action queue instead of losing the day.
    await this.watermarks.setContactMaintenanceWatermark(
      SECOND_ARROW_REVIEW_PROCESSOR,
      new Date(nowMs).toISOString(),
    );

    log.info('Second-arrow review complete', {
      actionId: action.id,
      localDay: today,
      writesScanned: writes.length,
      clustersConsidered: clusters.length,
      clustersSkipped,
      cardsRaised,
      cardsDeduplicated,
    });
  }

  private async hasRunOn(localDay: string, timeZone: string): Promise<boolean> {
    const watermark = await this.watermarks.getContactMaintenanceWatermark(
      SECOND_ARROW_REVIEW_PROCESSOR,
    );
    if (!watermark) return false;
    const watermarkMs = Date.parse(watermark);
    if (!Number.isFinite(watermarkMs)) {
      throw new Error(
        `Second-arrow review watermark "${watermark}" is not a valid timestamp`,
      );
    }
    return localCalendarDay(watermarkMs, timeZone) === localDay;
  }
}
