// ── Egress delivery recorder (psfn-framework-ccgdz.6) ──
//
// One shared seam between the three egress surfaces and the durable delivery
// record. It owns three things the call sites must not each reinvent:
//
//  1. Building the content-free record from the turn's custody proof, the
//     resolved destination, and the bytes' digest.
//  2. Writing it WITHOUT throwing. A custody-store outage must not become a
//     turn failure, but it must never be silent either: the failure is logged
//     and reported back so a proof-requiring caller can hold instead of
//     claiming a delivery it cannot prove (design §4 rule 6).
//  3. Resolving the enforcement posture from the existing CogSec mode through
//     `cogSecItemEnforcementPosture(mode, 'outbound_publication')` — no new
//     switch, no second policy. Shadow observes; boundary and strict withhold.
//
// The write is a single indexed insert. It adds no model call and no extra
// round trip beyond that insert, so the user hot path stays bounded.

import {
  cogSecItemEnforcementPosture,
  type CogSecMode,
  type IntakeEnforcementPosture,
} from '../../../shared/contracts/cogsec-mode.js';
import { resolveHealthEventOwner } from '../../../shared/contracts/health-event.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import { custodyIdentity } from './custody-snapshot.js';
import type { DisclosureClassification, DisclosureDestination } from './contracts.js';
import {
  egressDeliveryDestination,
  egressDeliveryRef,
  validateEgressDeliveryRecord,
  type EgressCustodyHoldReason,
  type EgressDeliveryDisposition,
  type EgressDeliveryRecord,
  type EgressDeliveryRecordStorePort,
  type EgressDeliverySurface,
  type TurnEgressCustodyProof,
} from './egress-delivery-record.js';

const log = createComponentLogger('egress-delivery-recorder');

/** The most restrictive floor, used when a turn published no lineage at all. */
const UNKNOWN_LINEAGE_SENSITIVITY: SensitivityLevel = 'confidential';
const UNKNOWN_LINEAGE_CLASSIFICATION: DisclosureClassification = 'non_shareable';

export interface EgressDeliveryRecordRequest {
  surface: EgressDeliverySurface;
  disposition: EgressDeliveryDisposition;
  /** `turn:<turnId>` correlation; the turn that produced these bytes. */
  turnId: string;
  /** The existing call-site reference this attempt is keyed by. */
  attemptRef: string;
  /** sha256 of the bytes released, or of the bytes withheld. */
  contentSha256: string;
  destination: DisclosureDestination | null;
  proof: TurnEgressCustodyProof | undefined;
  /** The composed decision's classification; defaults to the lineage's own. */
  outcome?: DisclosureClassification;
  decisionAllowed: boolean;
  holdReason?: EgressCustodyHoldReason;
  /** The inbound event this egress answers, when the surface carries one. */
  triggerEventRef?: string;
}

/** Whether the durable record for this egress actually exists. */
export interface EgressDeliveryRecordResult {
  readonly written: boolean;
  readonly record: EgressDeliveryRecord | null;
}

export interface EgressDeliveryRecorderOptions {
  store: EgressDeliveryRecordStorePort;
  /** Owning companion; absent binds the row to the system (HealthEventOwner). */
  companionId?: string | undefined;
  /** Live CogSec mode; read per call so an owner-file reload takes effect. */
  getCogSecMode: () => CogSecMode;
  now?: () => number;
}

/**
 * Writes the durable binding between delivered bytes and the custody proof that
 * authorized them. Construct once per runtime and share across every egress
 * surface so one turn's tool sends, artifact shares, and autonomous replies all
 * land in the same ledger.
 */
export class EgressDeliveryRecorder {
  private readonly store: EgressDeliveryRecordStorePort;
  private readonly companionId: string | undefined;
  private readonly getCogSecMode: () => CogSecMode;
  private readonly now: () => number;

  constructor(options: EgressDeliveryRecorderOptions) {
    this.store = options.store;
    this.companionId = options.companionId;
    this.getCogSecMode = options.getCogSecMode;
    this.now = options.now ?? Date.now;
  }

  /**
   * The posture this egress decision is taken under. Registered outbound
   * publication is an external CogSec vector, so `boundary` and `strict` both
   * enforce and only `shadow` observes.
   */
  enforcementPosture(): IntakeEnforcementPosture {
    return cogSecItemEnforcementPosture(this.getCogSecMode(), 'outbound_publication');
  }

  /**
   * Write one delivery record. Never throws: a failed write is logged and
   * reported as `written: false` so a proof-requiring caller can hold rather
   * than release bytes it cannot account for.
   */
  async record(request: EgressDeliveryRecordRequest): Promise<EgressDeliveryRecordResult> {
    let built: EgressDeliveryRecord;
    try {
      built = this.build(request);
    } catch (error) {
      log.error('Egress delivery record could not be built', {
        surface: request.surface,
        turnId: request.turnId,
        error: toErrorMessage(error),
      });
      return { written: false, record: null };
    }
    try {
      const outcome = await this.store.record(built);
      if (outcome === 'diverged') {
        // Two egresses claimed the same (turn, attempt) key with different
        // decisions. The stored one stands — it is the decision the bytes
        // actually left under — and the divergence is never swallowed.
        log.error('Egress delivery record diverged from the stored record', {
          surface: built.surface,
          generationContextRef: built.generationContextRef,
          deliveryRef: built.deliveryRef,
        });
      }
      return { written: true, record: built };
    } catch (error) {
      log.error('Egress delivery record write failed; this egress has no durable record', {
        surface: built.surface,
        generationContextRef: built.generationContextRef,
        disposition: built.disposition,
        error: toErrorMessage(error),
      });
      return { written: false, record: built };
    }
  }

  private build(request: EgressDeliveryRecordRequest): EgressDeliveryRecord {
    const generationContextRef = `turn:${request.turnId}`;
    const attempt = custodyIdentity(request.attemptRef);
    const { proof } = request;
    return validateEgressDeliveryRecord({
      schemaVersion: 1,
      deliveryRef: egressDeliveryRef(generationContextRef, attempt),
      generationContextRef,
      turnId: request.turnId,
      owner: resolveHealthEventOwner(this.companionId),
      surface: request.surface,
      disposition: request.disposition,
      enforcementPosture: this.enforcementPosture(),
      attempt,
      contentSha256: request.contentSha256,
      ...(request.destination
        ? { destination: egressDeliveryDestination(request.destination) }
        : {}),
      outcome: request.outcome ?? proof?.classification ?? UNKNOWN_LINEAGE_CLASSIFICATION,
      decisionAllowed: request.decisionAllowed,
      ...(request.holdReason !== undefined ? { holdReason: request.holdReason } : {}),
      ...(proof?.custodySnapshotRef !== undefined
        ? { custodySnapshotRef: proof.custodySnapshotRef }
        : {}),
      sourceCount: proof?.sourceCount ?? 0,
      hasUnclassifiedSource: proof?.hasUnclassifiedSource ?? false,
      effectiveSensitivity: proof?.effectiveSensitivity ?? UNKNOWN_LINEAGE_SENSITIVITY,
      ...(request.triggerEventRef !== undefined
        ? { triggerEventRef: custodyIdentity(request.triggerEventRef) }
        : {}),
      recordedAtMs: this.now(),
    });
  }
}
