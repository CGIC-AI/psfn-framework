// ── One turn's per-tool-result custody row (psfn-framework-ccgdz.5) ──
//
// This type is the join between two modules that must not depend on each other:
// `turn-records.ts` DERIVES the row while recording tool observations, and
// `turn-execution/contracts.ts` DECLARES the runtime seams that carry it. Both
// importing the other is a genuine import cycle, so the shared shape lives
// here — beside its producer, above both consumers — and neither file has to
// reach across the seam for a type.
//
// It stays in `core/agent/substrate-agent/` rather than in
// `shared/contracts/tool-result-custody.ts` because it names a
// `DisclosureToolResultSource` and an `IntakeEnvelopeSnapshot`: the CogSec
// disclosure and intake shapes are core concepts, and hoisting the row into
// `shared/contracts` would make that the first `shared -> core` contract import.
// The content-free EDGE it carries is the shared half, and that already lives
// in `shared/contracts/tool-result-custody.ts`.

import type { DisclosureToolResultSource } from '../../cogsec/disclosure/generation-lineage.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import type { ToolResultCustodyEdge } from '../../../shared/contracts/tool-result-custody.js';

/**
 * One observed tool result's content-free custody row.
 *
 * The edge is derived ONCE, in `recordToolObservations`, where the post-record
 * envelope snapshot is in hand. Both the turn's custody snapshot and the
 * `TurnRecordToolCall` consume this same value, so the two cannot drift and
 * "the snapshot's tool-result contributions match the TurnRecord's" holds by
 * construction rather than by two implementations agreeing.
 */
export interface TurnToolResultCustodyRecord {
  /** The content-free lineage ref this result folds into (`tool:<name>[:<id>]`). */
  readonly ref: string;
  /** The disclosure fold's view of this result. */
  readonly disclosureSource: DisclosureToolResultSource;
  /** The envelope that admitted the result, when the firewall produced one. */
  readonly intakeEnvelope?: IntakeEnvelopeSnapshot;
  readonly custody: ToolResultCustodyEdge;
}
