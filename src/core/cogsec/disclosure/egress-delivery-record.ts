// ── Egress delivery record and fail-closed provenance hold (psfn-framework-ccgdz.6) ──
//
// `CustodySnapshot` (ccgdz.1) records which sources were admitted into the
// context that produced a generation. It does not record what was then actually
// released, to whom, or on whose authority. An `EgressDeliveryRecord` closes
// that last hop: it binds the exact bytes an egress carried
// (`contentSha256`) to the turn that produced them (`turn:<turnId>`), the
// custody snapshot that proves their provenance, the resolved
// `DisclosureDestination`, and the decision outcome that released or held them.
//
// NO NEW IDENTIFIER (design §2). The record's key is a composite of identifiers
// the runtime already mints: the lineage's own `generationContextRef` plus the
// attempt reference the call site already carries (a tool call id, an inbound
// trigger event id, an approval scope). One turn can release more than once, so
// the turn key alone cannot be the primary key; a digest of the existing
// attempt reference disambiguates without inventing a trace id.
//
// CONTENT-FREE BY CONSTRUCTION (design §4), the same discipline as
// `custody-snapshot.ts`: every field is an id, a hash, a count, a boolean, a
// closed-vocabulary label, or a timestamp. Free-form runtime references
// (channel ids, contact ids, tool call ids) go through `custodyIdentity`, which
// always stores the sha256 and retains the literal only when it is a bounded
// safe token. A `contentSha256` is a join key, never the content.
//
// Ownership follows the `HealthEventOwner` pattern and reuses that exact type:
// every row belongs to the system or to exactly one companion, so a fleet audit
// never mixes companions.

import { createHash } from 'node:crypto';

import { canonicalJsonString } from '../../../shared/utils/json-serialization.js';
import {
  validateHealthEventOwner,
  type HealthEventOwner,
} from '../../../shared/contracts/health-event.js';
import { isRecord } from '../../../shared/utils/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../system/trust/types.js';
import type { IntakeEnforcementPosture } from '../../../shared/contracts/cogsec-mode.js';
import {
  custodyIdentity,
  custodySha256,
  validateCustodyIdentity,
  type CustodyIdentity,
} from './custody-snapshot.js';
import {
  isDisclosureClassification,
  isDisclosureDestinationKind,
  type DisclosureClassification,
  type DisclosureDestination,
  type DisclosureDestinationKind,
  type DisclosureLineage,
} from './contracts.js';

const EGRESS_DELIVERY_RECORD_SCHEMA_VERSION = 1;

/**
 * The egress surfaces that write a delivery record. Closed: a new surface is a
 * reviewed contract change, never a runtime string.
 *
 * - `social_reply`   — an autonomous room reply delivered through the speaking
 *                      arbiter's egress lease (`egress-reply-sender.ts`).
 * - `tool_egress`    — a model-invoked egress-capable tool call, recorded
 *                      record-first by the egress tool guard before the tool runs.
 * - `artifact_share` — generated files/images leaving on a turn's reply.
 */
const EGRESS_DELIVERY_SURFACES = [
  'social_reply',
  'tool_egress',
  'artifact_share',
] as const;

export type EgressDeliverySurface = typeof EGRESS_DELIVERY_SURFACES[number];

function isEgressDeliverySurface(value: unknown): value is EgressDeliverySurface {
  return typeof value === 'string'
    && (EGRESS_DELIVERY_SURFACES as readonly string[]).includes(value);
}

/**
 * What actually happened to the bytes.
 *
 * `released` means the egress was authorized and the bytes were handed to the
 * transport. The tool and artifact surfaces write record-first — the record
 * exists before the send — so `released` is an authorization fact, not a
 * platform delivery receipt; the existing outbound ambiguity rules
 * (`egress-reply-sender.ts`) still own "did the platform accept it".
 */
const EGRESS_DELIVERY_DISPOSITIONS = ['released', 'held'] as const;

export type EgressDeliveryDisposition = typeof EGRESS_DELIVERY_DISPOSITIONS[number];

function isEgressDeliveryDisposition(value: unknown): value is EgressDeliveryDisposition {
  return typeof value === 'string'
    && (EGRESS_DELIVERY_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * Why a proof-requiring outward egress cannot be released. Closed vocabulary —
 * a hold is always explainable to an operator without reading any content.
 *
 * The first two are NEW conditions introduced by this bead (custody durability).
 * The rest restate conditions `assessDisclosure` already denies on (§9.5); they
 * appear here so the record says WHICH fail-closed rule fired rather than
 * leaving an operator to re-derive it.
 */
const EGRESS_CUSTODY_HOLD_REASONS = [
  /** The turn folded a lineage but no durable custody snapshot survives for it. */
  'custody_snapshot_missing',
  /** The delivery record itself could not be written; custody is not durable. */
  'custody_store_unavailable',
  /** No per-turn disclosure lineage was published at all. */
  'lineage_missing',
  /** `sourceCount === 0` — no admitted source, so nothing proves provenance. */
  'no_admitted_source',
  /** `hasUnclassifiedSource` — an admitted source carried no usable lineage. */
  'unclassified_source',
] as const;

export type EgressCustodyHoldReason = typeof EGRESS_CUSTODY_HOLD_REASONS[number];

function isEgressCustodyHoldReason(value: unknown): value is EgressCustodyHoldReason {
  return typeof value === 'string'
    && (EGRESS_CUSTODY_HOLD_REASONS as readonly string[]).includes(value);
}

/**
 * The custody-snapshot state a delivery record carries BESIDES the two its ref
 * already expresses (present ⇒ the snapshot exists; absent ⇒ none survives for
 * this turn).
 *
 * `pending` is the in-turn state. A model-invoked tool egress is recorded
 * record-first, DURING the turn, and the turn folds its custody snapshot only
 * after the model's tool loop returns — so no ref can exist yet. The chain is
 * intact (the decision was taken against the turn's own published lineage) but
 * not yet durable, and the row resolves through its own `generationContextRef`
 * (`turn:<turnId>`) once the fold lands. It is NOT an absence of proof, and it
 * is never written by an out-of-turn deliverer, which always runs post-fold.
 */
const EGRESS_CUSTODY_SNAPSHOT_STATES = ['pending'] as const;

export type EgressCustodySnapshotState = typeof EGRESS_CUSTODY_SNAPSHOT_STATES[number];

function isEgressCustodySnapshotState(value: unknown): value is EgressCustodySnapshotState {
  return typeof value === 'string'
    && (EGRESS_CUSTODY_SNAPSHOT_STATES as readonly string[]).includes(value);
}

/**
 * The content-free custody proof a completed turn hands to whatever delivers
 * its output. It is a projection of the turn's folded `DisclosureLineage` plus
 * the durable ref the custody snapshot write returned — never the lineage
 * itself, so it can ride on a response without carrying source refs.
 */
export interface TurnEgressCustodyProof {
  /** `turn:<turnId>`, present only when the snapshot write actually succeeded. */
  readonly custodySnapshotRef?: string;
  readonly sourceCount: number;
  readonly hasUnclassifiedSource: boolean;
  readonly classification: DisclosureClassification;
  readonly effectiveSensitivity: SensitivityLevel;
}

/**
 * The LIVE per-turn egress custody state.
 *
 * `turnId` is published BEFORE the turn generates, because a model-invoked
 * egress tool runs inside the generation and its delivery record needs the
 * turn's correlation key at that moment. `proof` appears only once the turn
 * folds its lineage and its record-first custody snapshot write settles, so an
 * absent proof means "this turn has not folded yet", never "this turn has no
 * provenance".
 */
export interface ActiveTurnEgressCustody {
  readonly turnId: string;
  readonly proof?: TurnEgressCustodyProof;
}

/**
 * One completed turn's custody proof together with the correlation it is keyed
 * by. This is a LIVE in-process handoff, never durable state: the durable form
 * is the custody snapshot itself, and the turn's persisted delivery-recovery row
 * is a closed contract that must not grow a second copy of the same fact.
 */
export interface CompletedTurnEgressCustody extends ActiveTurnEgressCustody {
  readonly proof: TurnEgressCustodyProof;
}

/**
 * One-shot capture of a completed turn's egress custody, taken just before the
 * live per-turn state is cleared. Out-of-turn deliverers (the speaking
 * arbiter's autonomous reply sender) read the proof through this rather than
 * off the response, so nothing durable has to carry it.
 */
export type CompletedTurnEgressCustodyCapture = (
  custody: CompletedTurnEgressCustody | null,
) => void;

/** Project a folded lineage plus its durable ref into the deliverer's proof. */
export function turnEgressCustodyProof(
  lineage: DisclosureLineage,
  custodySnapshotRef: string | undefined,
): TurnEgressCustodyProof {
  return {
    ...(custodySnapshotRef !== undefined ? { custodySnapshotRef } : {}),
    sourceCount: lineage.sourceCount,
    hasUnclassifiedSource: lineage.hasUnclassifiedSource,
    classification: lineage.classification,
    effectiveSensitivity: lineage.effectiveSensitivity,
  };
}

/**
 * Does this destination require a provable chain of custody? `companion_self`
 * is the private sink and never does; a null destination means no outward
 * social destination was derivable, so the existing sink gate governs alone.
 * Every other destination class carries content across the companion boundary.
 */
export function destinationRequiresCustodyProof(
  destination: DisclosureDestination | null,
): boolean {
  return destination !== null && destination.kind !== 'companion_self';
}

/**
 * Detect the fail-closed custody condition for one egress, or `null` when the
 * chain is complete (or no proof is required for this destination).
 *
 * PURE DETECTION ONLY. Whether a detected condition actually withholds is the
 * CALLER's decision, because the two egress surfaces sit differently:
 *   - The tool guard composes over `assessDisclosure`, which ALREADY denies
 *     unconditionally on a missing/unclassified lineage. Making those
 *     observe-only under `shadow` there would WIDEN an existing gate, which
 *     `egress-composition.ts` forbids. Only the custody-durability conditions
 *     are posture-gated on that path.
 *   - The autonomous reply sender had no such gate before this bead, so every
 *     condition there is new and honours the enforcement posture (design §5:
 *     land the hold in shadow first).
 */
export function evaluateEgressCustodyHold(input: {
  destination: DisclosureDestination | null;
  proof: TurnEgressCustodyProof | undefined;
  /**
   * Force the proof requirement when the caller knows the egress is outward
   * even though no destination CLASS was resolvable — artifact egress past its
   * self/primary-contact return is outward by audience, and treating an
   * unresolvable channel as "no proof needed" would be the widening this
   * whole gate exists to prevent.
   */
  requiresProof?: boolean;
  /**
   * The turn that produced these bytes is STILL GENERATING: its custody
   * snapshot is folded after the model's tool loop returns, so an absent ref is
   * "not written yet" rather than "never written". Only an in-turn caller (the
   * egress tool guard) may set this; every out-of-turn deliverer runs post-fold,
   * where an absent ref is a genuinely missing snapshot and must still hold.
   *
   * It widens nothing else. The snapshot check is deliberately the LAST branch,
   * so a turn with no published lineage, no admitted source, or an unclassified
   * source still holds exactly as it did before — pending or not.
   */
  custodySnapshotPending?: boolean;
}): EgressCustodyHoldReason | null {
  const requiresProof = input.requiresProof ?? destinationRequiresCustodyProof(input.destination);
  if (!requiresProof) return null;
  const { proof } = input;
  if (!proof) return 'lineage_missing';
  if (proof.sourceCount === 0) return 'no_admitted_source';
  if (proof.hasUnclassifiedSource) return 'unclassified_source';
  if (proof.custodySnapshotRef === undefined) {
    return input.custodySnapshotPending === true ? null : 'custody_snapshot_missing';
  }
  return null;
}

/**
 * Hold reasons introduced by this bead. A caller that composes over an existing
 * unconditional gate posture-gates ONLY these; the rest are already enforced by
 * `assessDisclosure` and must never be relaxed by a shadow posture.
 */
const CUSTODY_DURABILITY_HOLD_REASONS: ReadonlySet<EgressCustodyHoldReason> = new Set([
  'custody_snapshot_missing',
  'custody_store_unavailable',
]);

export function isCustodyDurabilityHoldReason(reason: EgressCustodyHoldReason): boolean {
  return CUSTODY_DURABILITY_HOLD_REASONS.has(reason);
}

/** The resolved outward destination, reduced to identity. */
export interface EgressDeliveryDestination {
  readonly kind: DisclosureDestinationKind;
  /** Hashed channel/contact id; absent for the id-free kinds. */
  readonly ref?: CustodyIdentity;
  /** The room's classification epoch at decision time, when tracked. */
  readonly currentEpoch?: number;
}

/** Reduce a `DisclosureDestination` to its content-free delivery identity. */
export function egressDeliveryDestination(
  destination: DisclosureDestination,
): EgressDeliveryDestination {
  switch (destination.kind) {
    case 'companion_self':
    case 'publication':
      return { kind: destination.kind };
    case 'contact_dm':
      return { kind: destination.kind, ref: custodyIdentity(destination.contactId) };
    case 'invite_only_room':
    case 'public_room':
      return {
        kind: destination.kind,
        ref: custodyIdentity(destination.channelId),
        ...(destination.currentEpoch !== undefined
          ? { currentEpoch: destination.currentEpoch }
          : {}),
      };
  }
}

/**
 * The durable binding of one egress: what left (or did not), from which turn,
 * on which custody proof, to which destination, under which decision.
 */
export interface EgressDeliveryRecord {
  readonly schemaVersion: typeof EGRESS_DELIVERY_RECORD_SCHEMA_VERSION;
  /** `<generationContextRef>#<attempt digest>` — a composite of existing ids. */
  readonly deliveryRef: string;
  /** `turn:<turnId>`; also the custody snapshot key when one was written. */
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly owner: HealthEventOwner;
  readonly surface: EgressDeliverySurface;
  readonly disposition: EgressDeliveryDisposition;
  /** The posture the decision was taken under; `shadow` observes but releases. */
  readonly enforcementPosture: IntakeEnforcementPosture;
  /** Existing call-site reference this attempt is keyed by (tool call, event). */
  readonly attempt: CustodyIdentity;
  /** sha256 of the exact bytes released, or of the bytes that were withheld. */
  readonly contentSha256: string;
  /** Resolved outward destination; absent when none was derivable. */
  readonly destination?: EgressDeliveryDestination;
  /** The composed decision's classification outcome. */
  readonly outcome: DisclosureClassification;
  /** The composed decision's release answer, before any custody hold. */
  readonly decisionAllowed: boolean;
  /**
   * The detected fail-closed custody condition, when any. Present with
   * `disposition: 'released'` exactly when a `shadow` posture observed the
   * condition without withholding.
   */
  readonly holdReason?: EgressCustodyHoldReason;
  /** The custody snapshot this egress claims as its proof, when one exists. */
  readonly custodySnapshotRef?: string;
  /**
   * `pending` when the record was written mid-turn, before the turn folded its
   * custody snapshot. Mutually exclusive with `custodySnapshotRef`: the ref is
   * the proof, this is the promise that the proof is being written for the same
   * `generationContextRef` this row already names.
   */
  readonly custodySnapshot?: EgressCustodySnapshotState;
  readonly sourceCount: number;
  readonly hasUnclassifiedSource: boolean;
  readonly effectiveSensitivity: SensitivityLevel;
  /** Hashed inbound event that triggered this egress, when the surface has one. */
  readonly triggerEventRef?: CustodyIdentity;
  readonly recordedAtMs: number;
}

/** Compose the delivery key from two identifiers the runtime already minted. */
export function egressDeliveryRef(
  generationContextRef: string,
  attempt: CustodyIdentity,
): string {
  return `${generationContextRef}#${attempt.digest}`;
}

/**
 * The identity digest of a record's CONTENT, deliberately excluding
 * `recordedAtMs` — a retried attempt re-derives the same decision at a new
 * instant, and the store must recognize that as a duplicate rather than a
 * divergence (the `custodySnapshotContentDigest` posture).
 */
export function egressDeliveryRecordContentDigest(record: EgressDeliveryRecord): string {
  const { recordedAtMs: _recordedAtMs, ...content } = record;
  return createHash('sha256')
    .update(canonicalJsonString(content, 'egress delivery record'), 'utf8')
    .digest('hex');
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const EGRESS_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

function invalid(field: string, requirement: string): Error {
  return new Error(`Egress delivery record ${field} ${requirement}`);
}

function validateCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(field, 'must be a non-negative safe integer');
  }
  return value as number;
}

function validateDestination(value: unknown): EgressDeliveryDestination {
  if (!isRecord(value)) throw invalid('destination', 'must be an object');
  if (!isDisclosureDestinationKind(value.kind)) {
    throw invalid('destination.kind', 'must be a known disclosure destination kind');
  }
  if (value.currentEpoch !== undefined
    && (!Number.isSafeInteger(value.currentEpoch) || (value.currentEpoch as number) < 0)) {
    throw invalid('destination.currentEpoch', 'must be a non-negative safe integer');
  }
  return {
    kind: value.kind,
    ...(value.ref !== undefined
      ? { ref: validateCustodyIdentity(value.ref, 'destination.ref') }
      : {}),
    ...(value.currentEpoch !== undefined ? { currentEpoch: value.currentEpoch as number } : {}),
  };
}

/**
 * Re-validate on every read as well as every write (the `validateCogSecReceipt`
 * posture): a row edited in the database is a load failure, never a quiet
 * custody claim.
 */
export function validateEgressDeliveryRecord(value: unknown): EgressDeliveryRecord {
  if (!isRecord(value)) throw invalid('record', 'must be an object');
  if (value.schemaVersion !== EGRESS_DELIVERY_RECORD_SCHEMA_VERSION) {
    throw invalid('schemaVersion', `must be ${EGRESS_DELIVERY_RECORD_SCHEMA_VERSION}`);
  }
  if (typeof value.turnId !== 'string' || !EGRESS_SAFE_IDENTIFIER_PATTERN.test(value.turnId)) {
    throw invalid('turnId', 'must be a bounded safe identifier');
  }
  if (value.generationContextRef !== `turn:${value.turnId}`) {
    throw invalid('generationContextRef', 'must be turn:<turnId>');
  }
  if (!isEgressDeliverySurface(value.surface)) {
    throw invalid('surface', 'must be a known egress delivery surface');
  }
  if (!isEgressDeliveryDisposition(value.disposition)) {
    throw invalid('disposition', 'must be a known egress delivery disposition');
  }
  if (value.enforcementPosture !== 'shadow' && value.enforcementPosture !== 'enforce') {
    throw invalid('enforcementPosture', "must be 'shadow' or 'enforce'");
  }
  const attempt = validateCustodyIdentity(value.attempt, 'attempt');
  if (typeof value.contentSha256 !== 'string' || !SHA256_HEX_PATTERN.test(value.contentSha256)) {
    throw invalid('contentSha256', 'must be 64 lowercase hex characters');
  }
  if (!isDisclosureClassification(value.outcome)) {
    throw invalid('outcome', 'must be a known disclosure classification');
  }
  if (typeof value.decisionAllowed !== 'boolean') {
    throw invalid('decisionAllowed', 'must be a boolean');
  }
  if (value.holdReason !== undefined && !isEgressCustodyHoldReason(value.holdReason)) {
    throw invalid('holdReason', 'must be a known egress custody hold reason');
  }
  if (value.disposition === 'held' && value.holdReason === undefined) {
    // A hold with no stated reason is exactly the "silently dropped" outcome
    // the design forbids; refuse the row rather than store an unexplained hold.
    throw invalid('holdReason', 'is required when the disposition is held');
  }
  if (value.custodySnapshotRef !== undefined
    && value.custodySnapshotRef !== value.generationContextRef) {
    // The proof a delivery cites must be the proof of the turn it came from.
    throw invalid('custodySnapshotRef', 'must equal the generation context ref');
  }
  if (value.custodySnapshot !== undefined && !isEgressCustodySnapshotState(value.custodySnapshot)) {
    throw invalid('custodySnapshot', 'must be a known custody snapshot state');
  }
  if (value.custodySnapshot !== undefined && value.custodySnapshotRef !== undefined) {
    // A row cannot both cite a written snapshot and claim one is still pending.
    throw invalid('custodySnapshot', 'must be absent when a custody snapshot ref is cited');
  }
  if (typeof value.hasUnclassifiedSource !== 'boolean') {
    throw invalid('hasUnclassifiedSource', 'must be a boolean');
  }
  if (!VALID_SENSITIVITY_LEVELS.includes(value.effectiveSensitivity as SensitivityLevel)) {
    throw invalid('effectiveSensitivity', 'must be a known sensitivity level');
  }
  if (!Number.isSafeInteger(value.recordedAtMs) || (value.recordedAtMs as number) <= 0) {
    throw invalid('recordedAtMs', 'must be a positive safe integer');
  }
  const deliveryRef = egressDeliveryRef(value.generationContextRef, attempt);
  if (value.deliveryRef !== deliveryRef) {
    throw invalid('deliveryRef', 'must be <generationContextRef>#<attempt digest>');
  }
  return {
    schemaVersion: EGRESS_DELIVERY_RECORD_SCHEMA_VERSION,
    deliveryRef,
    generationContextRef: value.generationContextRef,
    turnId: value.turnId,
    owner: validateHealthEventOwner(value.owner),
    surface: value.surface,
    disposition: value.disposition,
    enforcementPosture: value.enforcementPosture,
    attempt,
    contentSha256: value.contentSha256,
    ...(value.destination !== undefined
      ? { destination: validateDestination(value.destination) }
      : {}),
    outcome: value.outcome,
    decisionAllowed: value.decisionAllowed,
    ...(value.holdReason !== undefined ? { holdReason: value.holdReason } : {}),
    ...(value.custodySnapshotRef !== undefined
      ? { custodySnapshotRef: value.custodySnapshotRef as string }
      : {}),
    ...(value.custodySnapshot !== undefined
      ? { custodySnapshot: value.custodySnapshot }
      : {}),
    sourceCount: validateCount(value.sourceCount, 'sourceCount'),
    hasUnclassifiedSource: value.hasUnclassifiedSource,
    effectiveSensitivity: value.effectiveSensitivity as SensitivityLevel,
    ...(value.triggerEventRef !== undefined
      ? { triggerEventRef: validateCustodyIdentity(value.triggerEventRef, 'triggerEventRef') }
      : {}),
    recordedAtMs: value.recordedAtMs as number,
  };
}

/** The bytes an egress carries, reduced to their join key. */
export function egressContentSha256(content: string): string {
  return custodySha256(content);
}

/** Outcome of recording one delivery; first write wins, like custody snapshots. */
export type EgressDeliveryRecordOutcome = 'recorded' | 'duplicate' | 'diverged';

/** Durable egress-delivery sink, sibling of {@link CustodySnapshotStorePort}. */
export interface EgressDeliveryRecordStorePort {
  record(record: EgressDeliveryRecord): Promise<EgressDeliveryRecordOutcome>;
  getByDeliveryRef(deliveryRef: string): Promise<EgressDeliveryRecord | null>;
  listByGenerationContextRef(ref: string): Promise<readonly EgressDeliveryRecord[]>;
  close(): Promise<void>;
}
