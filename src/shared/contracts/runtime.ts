import type { ChannelType } from './channel-types.js';
import type { TurnID } from './turn-contracts.js';
import type { ChannelPrivacy } from './trust-contracts.js';
import type { IcpConversationCorrelation } from './icp-autonomy.js';
import type {
  ParentTurnContinuationStop,
  TurnRecordAuditPrivacy,
  TurnRecordBackgroundWorkHandoff,
  TurnRecordLocation,
  TurnRecordMessage,
  TurnRecordToolCall,
  TurnRecordVersionPointers,
} from './runtime-base.js';

export * from './runtime-base.js';
export * from './message-addressing.js';
export * from './tool-call-outcome.js';


/**
 * Why a turn has no durable custody snapshot (psfn-framework-ccgdz.1).
 *
 * - `no_custody_store` — this deployment wires no custody snapshot store, so
 *                        nothing was attempted. Not a fault.
 * - `write_failed`     — the store was asked and refused or threw. The turn
 *                        still completes: converting a custody-store outage
 *                        into a turn failure would silence the companion over a
 *                        write that only records what already happened.
 * - `diverged`         — a snapshot for this generation context already exists
 *                        and disagrees with this turn's fold. The FIRST
 *                        snapshot stands, because it is the fold that produced
 *                        the delivered reply, so this turn may not point at it
 *                        as if it were its own proof.
 */
const TURN_CUSTODY_SNAPSHOT_ABSENCE_REASONS = [
  'no_custody_store',
  'write_failed',
  'diverged',
] as const;

export type TurnCustodySnapshotAbsenceReason =
  typeof TURN_CUSTODY_SNAPSHOT_ABSENCE_REASONS[number];

/** Fail-closed admission for a stored or transported absence reason. */
export function isTurnCustodySnapshotAbsenceReason(
  value: unknown,
): value is TurnCustodySnapshotAbsenceReason {
  return typeof value === 'string'
    && (TURN_CUSTODY_SNAPSHOT_ABSENCE_REASONS as readonly string[]).includes(value);
}

/**
 * What the record-first custody write produced. Exactly one of the two is
 * present: either the turn's durable proof is identified, or the reason it is
 * not is named. There is no third state in which the seam says nothing.
 */
export type TurnCustodySnapshotOutcome =
  | { readonly ref: string }
  | { readonly absenceReason: TurnCustodySnapshotAbsenceReason };

export interface TurnRecord {
  schemaVersion: 1;
  turnId: TurnID;
  requestId: string;
  /** Logical session that owned the turn; distinct from the exact source channel. */
  sessionId?: string;
  channelId: string;
  channelType: ChannelType;
  startedAt: number;
  completedAt: number;
  status: 'completed' | 'failed';
  /** Present when the parent-turn continuation fuse terminated this run. */
  continuationStop?: ParentTurnContinuationStop;
  /** Durable room/satellite place origin; absent on unbound turns. */
  location?: TurnRecordLocation;
  auditPrivacy?: TurnRecordAuditPrivacy;
  /** Gateway/session disclosure classification captured for this turn. */
  channelPrivacy?: ChannelPrivacy;
  userMessage: TurnRecordMessage;
  assistantMessage?: TurnRecordMessage;
  toolCalls: TurnRecordToolCall[];
  /**
   * Resolvable reference to this turn's durable context source manifest
   * (psfn-framework-ccgdz.4) — the same deterministic `turn:<turnId>` key the
   * custody snapshot uses, so no identifier is minted for it.
   *
   * Absent when no manifest was recorded, which is the honest state.
   *
   * DIVERGENCE CAVEAT (psfn-framework-8nq3h): unlike `custodySnapshotRef`,
   * which is WITHHELD when a second fold of the same turn disagrees with the
   * stored record, this ref is still returned on a `diverged` context-manifest
   * write. Because the key is deterministic rather than content-addressed, it
   * then resolves to the FIRST stored manifest for this turn — a sibling fold
   * of the same turn, not necessarily the prompt assembly this record
   * describes. The divergence itself is logged at the write seam
   * (`recordTurnContextManifest`); a reader that must prove which fold produced
   * a given reply reads `custodySnapshotRef`, whose absence is load-bearing.
   */
  contextManifestRef?: string;
  /**
   * Resolvable reference to this turn's durable CogSec custody snapshot
   * (psfn-framework-ccgdz.1) — the lineage's own `generationContextRef`,
   * `turn:<turnId>`. Absent when no custody store is wired or the record-first
   * write failed visibly; its absence is never a claim that the turn had no
   * admitted sources.
   */
  custodySnapshotRef?: string;
  /**
   * Why this turn carries no `custodySnapshotRef`. Exactly one of the two is
   * present on a turn that reached the custody seam, mirroring the intake
   * firewall's `receiptAbsence`: a bare missing ref cannot distinguish "no
   * custody store is wired in this deployment" from "the store rejected the
   * write", and the second is an operator's problem while the first is not.
   */
  custodySnapshotAbsence?: TurnCustodySnapshotAbsenceReason;
  internalStateSnapshotRef?: string;
  extractedMemoryIds: string[];
  concernDeltaRefs: string[];
  contactDeltaRefs: string[];
  roleEnvelopeRefs?: string[];
  observability?: import('../../core/turns/observability.js').TurnObservabilityRecord;
  versionPointers: TurnRecordVersionPointers;
  provenanceRefs: string[];
  /** Record-first, atomically enqueued post-turn work; safe to replay by turn ID. */
  backgroundWorkHandoff?: TurnRecordBackgroundWorkHandoff;
  /** Same-cluster autonomous-conversation lineage, when this is an ICP turn. */
  icpCorrelation?: IcpConversationCorrelation;
}
