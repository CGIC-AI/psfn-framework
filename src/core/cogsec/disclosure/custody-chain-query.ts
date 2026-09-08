// ── Content-free custody chain query seam (psfn-framework-ccgdz.7) ──
//
// The custody beads before this one WRITE the chain: the ingress receipt
// (ccgdz.2), the per-turn custody snapshot (ccgdz.1), the per-block context
// source manifest (ccgdz.4), the tool-result custody edge (ccgdz.5), and the
// egress delivery record (ccgdz.6). Nothing READ it back. This module is the
// pure projection that answers the epic's two AC-3 questions from that
// persisted state alone:
//
//   egress → sources   "which admitted message/context caused this egress?"
//   source → egresses  "where did this source's bytes end up?"
//
// It reuses the `publication-provenance.ts` discipline exactly: every
// dimension resolves to `present` or degrades to an explicit `unknown`, and a
// malformed record NEVER becomes a fabricated answer. The difference is the
// input — that module projects a live confirmation's params bag; this one
// projects durable rows.
//
// CONTENT-FREE BY REUSE, not by re-derivation. The three record types are
// already content-free by construction and are re-validated on every read by
// their own validators, so the view carries them as-is instead of copying
// their fields into a parallel shape that could drift. Everything this module
// ADDS is a count, a closed-vocabulary label, or a join key.
//
// THE JOIN IS THE POINT. The custody snapshot knows which sources were
// admitted; the context source manifest knows which of them were rendered into
// the prompt, and under which admission identity (receipt/envelope/hash). They
// share one key — `custodyIdentity(ref).digest` — so joining them turns "a
// source contributed" into "these exact admitted bytes were rendered into the
// prompt that produced the bytes this egress delivered".

import type { HealthEventOwner } from '../../../shared/contracts/health-event.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { CustodyIdentity } from './custody-identity.js';
import type { ContextSourceManifest } from './context-source-manifest.js';
import type { CustodySnapshot, CustodySnapshotSource } from './custody-snapshot.js';
import type { EgressDeliveryRecord } from './egress-delivery-record.js';
import type { DisclosureClassification } from './contracts.js';

/**
 * How one durable custody record resolved.
 *
 * `malformed` is deliberately distinct from `absent`: a row that failed its own
 * validator is evidence the chain is BROKEN, while a missing row may simply
 * mean the hop never happened. Collapsing them would hide a tampered record
 * behind the same answer as an unused surface.
 */
type CustodyChainRecordStatus = 'present' | 'absent' | 'malformed';

/** One resolved record, or the reason there is none. */
export type CustodyChainResolution<T> =
  | { readonly status: 'present'; readonly record: T }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed' };

/**
 * The chain dimensions that can be unknown. Closed vocabulary so an operator
 * reads WHICH hop is missing without any free text reaching the surface.
 */
type CustodyChainUnknownDimension =
  /** No custody snapshot resolved for the generation. */
  | 'custody_snapshot'
  /** No context source manifest resolved for the generation. */
  | 'context_manifest'
  /** No readable delivery record stands for the generation. */
  | 'egress_delivery'
  /** At least one admitted source carries no admission identity. */
  | 'source_admission_identity';

/** Admission identity for one source, joined from the context manifest. */
interface CustodyChainAdmissionView {
  /** `unknown` when no manifest row listed this source's ref. */
  readonly status: 'present' | 'unknown';
  readonly receiptId?: string;
  readonly contentSha256?: string;
  readonly envelopeId?: string;
}

/**
 * One admitted source, with what the prompt manifest knows about it folded in.
 * The snapshot half is carried verbatim; the manifest half is the join.
 */
interface CustodyChainSourceView {
  readonly source: CustodySnapshotSource;
  readonly admission: CustodyChainAdmissionView;
  /** Prompt blocks that rendered this source; `'unknown'` without a manifest. */
  readonly renderedBlockCount: number | 'unknown';
}

/** Answer to "which admitted message/context caused this egress?". */
export interface CustodyChainEgressToSourcesView {
  readonly direction: 'egress_to_sources';
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly snapshotStatus: CustodyChainRecordStatus;
  readonly manifestStatus: CustodyChainRecordStatus;
  readonly deliveryStatus: CustodyChainRecordStatus;
  readonly snapshot: CustodySnapshot | null;
  readonly manifest: ContextSourceManifest | null;
  readonly deliveries: readonly EgressDeliveryRecord[];
  /** Rows in range that failed their validator; `chainComplete` is false when >0. */
  readonly malformedDeliveryCount: number;
  readonly sources: readonly CustodyChainSourceView[];
  readonly sourceCount: number | 'unknown';
  readonly hasUnclassifiedSource: boolean | 'unknown';
  readonly classification: DisclosureClassification | 'unknown';
  readonly effectiveSensitivity: SensitivityLevel | 'unknown';
  readonly deliveryCount: number;
  readonly heldDeliveryCount: number;
  /** True only when snapshot, manifest, and at least one delivery all resolved. */
  readonly chainComplete: boolean;
  readonly unknownDimensions: readonly CustodyChainUnknownDimension[];
}

/** One generation this source contributed to, with what left because of it. */
interface CustodyChainSourceGenerationView {
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly snapshotStatus: CustodyChainRecordStatus;
  readonly classification: DisclosureClassification | 'unknown';
  readonly effectiveSensitivity: SensitivityLevel | 'unknown';
  readonly sourceCount: number | 'unknown';
  readonly hasUnclassifiedSource: boolean | 'unknown';
  readonly classifiedAtMs: number | 'unknown';
  readonly deliveries: readonly EgressDeliveryRecord[];
}

/** Bounded page cursor: a generation key and an instant, never free text. */
interface CustodyChainPageView {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** Answer to "where did this source's bytes end up?". */
export interface CustodyChainSourceToEgressesView {
  readonly direction: 'source_to_egresses';
  readonly source: CustodyIdentity;
  readonly generations: readonly CustodyChainSourceGenerationView[];
  readonly generationCount: number;
  readonly deliveryCount: number;
  readonly heldDeliveryCount: number;
  readonly malformedDeliveryCount: number;
  readonly page: CustodyChainPageView;
  readonly unknownDimensions: readonly CustodyChainUnknownDimension[];
}

/**
 * Durable custody reads for the query seam.
 *
 * Deliberately SEPARATE from `CustodySnapshotStorePort`: that port is the
 * turn's write path and every implementer of it must stay able to record. A
 * reader has no business gaining a `record` method to satisfy a query, and a
 * writer has no business gaining an index scan to satisfy a store.
 *
 * Every method returns a resolution rather than throwing on a malformed row,
 * because "this row does not validate" is an ANSWER the operator must see.
 * Infrastructure failures still throw — a dead pool is not an `unknown` chain.
 */
export interface CustodyChainSnapshotReadPort {
  resolveSnapshot(
    generationContextRef: string,
  ): Promise<CustodyChainResolution<CustodySnapshot>>;
  resolveContextManifest(
    generationContextRef: string,
  ): Promise<CustodyChainResolution<ContextSourceManifest>>;
  /**
   * Generations whose custody snapshot recorded a source with this ref digest,
   * newest first. Bounded by `limit`; `beforeClassifiedAtMs`/`beforeTurnId`
   * continue a keyset page.
   */
  listGenerationsBySourceDigest(input: {
    readonly sourceDigest: string;
    readonly limit: number;
    readonly beforeClassifiedAtMs?: number;
    readonly beforeTurnId?: string;
  }): Promise<readonly CustodyChainGenerationMatch[]>;
}

/** One generation that admitted the queried source. */
export interface CustodyChainGenerationMatch {
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly classifiedAtMs: number;
  readonly snapshot: CustodyChainResolution<CustodySnapshot>;
}

/**
 * A bounded list of delivery records, plus the number of rows in range that
 * FAILED their own validator.
 *
 * A malformed row is neither dropped silently nor allowed to fail the whole
 * audit read: an operator asking "what left on this turn?" must see both the
 * records that stand and the fact that one does not, or a tampered row would
 * look exactly like an egress that never happened.
 */
export interface CustodyChainDeliveryList {
  readonly records: readonly EgressDeliveryRecord[];
  readonly malformedCount: number;
}

export interface CustodyChainDeliveryReadPort {
  resolveDelivery(
    deliveryRef: string,
  ): Promise<CustodyChainResolution<EgressDeliveryRecord>>;
  /**
   * Every delivery record for the given generations, owner-filtered.
   *
   * `owner` is NOT optional and NOT nullable: a query seam that can be called
   * without an owner is a query seam that can cross a companion boundary. The
   * caller resolves the owner from the request context before it gets here.
   */
  listDeliveriesForGenerations(input: {
    readonly generationContextRefs: readonly string[];
    readonly owner: HealthEventOwner;
  }): Promise<CustodyChainDeliveryList>;
}

function sourceAdmissionIndex(
  manifest: ContextSourceManifest | null,
): Map<string, { admission: CustodyChainAdmissionView; blockCount: number }> {
  const index = new Map<string, { admission: CustodyChainAdmissionView; blockCount: number }>();
  if (!manifest) return index;
  for (const block of manifest.blocks) {
    for (const source of block.sources) {
      const existing = index.get(source.ref.digest);
      if (existing) {
        // A source rendered into several blocks keeps the FIRST identity seen
        // and only counts the extra block. Merging two different admission
        // claims for one ref would invent a proof neither block made.
        index.set(source.ref.digest, {
          admission: existing.admission,
          blockCount: existing.blockCount + 1,
        });
        continue;
      }
      index.set(source.ref.digest, {
        admission: {
          status: 'present',
          ...(source.receiptId !== undefined ? { receiptId: source.receiptId } : {}),
          ...(source.contentSha256 !== undefined
            ? { contentSha256: source.contentSha256 }
            : {}),
          ...(source.envelopeId !== undefined ? { envelopeId: source.envelopeId } : {}),
        },
        blockCount: 1,
      });
    }
  }
  return index;
}

/**
 * A delivery list with no readable record but at least one unreadable row is
 * `malformed`, not `absent`: the difference between "nothing left this turn"
 * and "what left cannot be read" is the whole point of the surface.
 */
function deliveryStatus(list: CustodyChainDeliveryList): CustodyChainRecordStatus {
  if (list.records.length > 0) return 'present';
  return list.malformedCount > 0 ? 'malformed' : 'absent';
}

function statusOf<T>(resolution: CustodyChainResolution<T>): CustodyChainRecordStatus {
  return resolution.status === 'present' ? 'present' : resolution.status;
}

function recordOf<T>(resolution: CustodyChainResolution<T>): T | null {
  return resolution.status === 'present' ? resolution.record : null;
}

/**
 * Project one generation's persisted custody records into the egress→sources
 * view.
 *
 * Every degradation is explicit. A missing snapshot does not silently produce
 * an empty source list that reads like "no sources contributed" — it produces
 * `sourceCount: 'unknown'` and names `custody_snapshot` in
 * `unknownDimensions`, which is the difference between a proven absence and an
 * unproven one.
 */
export function projectEgressToSources(input: {
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly snapshot: CustodyChainResolution<CustodySnapshot>;
  readonly manifest: CustodyChainResolution<ContextSourceManifest>;
  readonly deliveries: CustodyChainDeliveryList;
}): CustodyChainEgressToSourcesView {
  const snapshot = recordOf(input.snapshot);
  const manifest = recordOf(input.manifest);
  const admissionIndex = sourceAdmissionIndex(manifest);
  const sources = (snapshot?.sources ?? []).map((source): CustodyChainSourceView => {
    const joined = admissionIndex.get(source.ref.digest);
    return {
      source,
      admission: joined?.admission ?? { status: 'unknown' },
      renderedBlockCount: manifest === null ? 'unknown' : (joined?.blockCount ?? 0),
    };
  });
  const unknownDimensions: CustodyChainUnknownDimension[] = [];
  if (snapshot === null) unknownDimensions.push('custody_snapshot');
  if (manifest === null) unknownDimensions.push('context_manifest');
  if (input.deliveries.records.length === 0) unknownDimensions.push('egress_delivery');
  if (sources.some(source => source.admission.status === 'unknown')) {
    unknownDimensions.push('source_admission_identity');
  }
  return {
    direction: 'egress_to_sources',
    generationContextRef: input.generationContextRef,
    turnId: input.turnId,
    snapshotStatus: statusOf(input.snapshot),
    manifestStatus: statusOf(input.manifest),
    deliveryStatus: deliveryStatus(input.deliveries),
    snapshot,
    manifest,
    deliveries: input.deliveries.records,
    malformedDeliveryCount: input.deliveries.malformedCount,
    sources,
    sourceCount: snapshot?.sourceCount ?? 'unknown',
    hasUnclassifiedSource: snapshot?.hasUnclassifiedSource ?? 'unknown',
    classification: snapshot?.classification ?? 'unknown',
    effectiveSensitivity: snapshot?.effectiveSensitivity ?? 'unknown',
    deliveryCount: input.deliveries.records.length,
    heldDeliveryCount: input.deliveries.records.filter(
      delivery => delivery.disposition === 'held',
    ).length,
    chainComplete: snapshot !== null
      && manifest !== null
      && input.deliveries.records.length > 0
      && input.deliveries.malformedCount === 0,
    unknownDimensions,
  };
}

const CUSTODY_CHAIN_CURSOR_TURN_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

/** Keyset cursor over `(classifiedAtMs, turnId)` — two ids, no free text. */
export function encodeCustodyChainCursor(
  classifiedAtMs: number,
  turnId: string,
): string {
  return `${String(classifiedAtMs)}:${turnId}`;
}

/**
 * Decode a page cursor, or `null` when it is not the exact shape this module
 * emitted. Fails closed: an unreadable cursor restarts the page rather than
 * being coerced into an offset the caller did not ask for.
 */
export function decodeCustodyChainCursor(
  value: string,
): { readonly classifiedAtMs: number; readonly turnId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const instant = Number(value.slice(0, separator));
  const turnId = value.slice(separator + 1);
  if (!Number.isSafeInteger(instant) || instant <= 0) return null;
  if (!CUSTODY_CHAIN_CURSOR_TURN_PATTERN.test(turnId)) return null;
  return { classifiedAtMs: instant, turnId };
}

/** Project the source→egresses direction over one bounded page of matches. */
export function projectSourceToEgresses(input: {
  readonly source: CustodyIdentity;
  readonly matches: readonly CustodyChainGenerationMatch[];
  readonly deliveries: CustodyChainDeliveryList;
  readonly limit: number;
  readonly hasMore: boolean;
}): CustodyChainSourceToEgressesView {
  const byGeneration = new Map<string, EgressDeliveryRecord[]>();
  for (const delivery of input.deliveries.records) {
    const bucket = byGeneration.get(delivery.generationContextRef);
    if (bucket) bucket.push(delivery);
    else byGeneration.set(delivery.generationContextRef, [delivery]);
  }
  const generations = input.matches.map(
    (match): CustodyChainSourceGenerationView => {
      const snapshot = recordOf(match.snapshot);
      return {
        generationContextRef: match.generationContextRef,
        turnId: match.turnId,
        snapshotStatus: statusOf(match.snapshot),
        classification: snapshot?.classification ?? 'unknown',
        effectiveSensitivity: snapshot?.effectiveSensitivity ?? 'unknown',
        sourceCount: snapshot?.sourceCount ?? 'unknown',
        hasUnclassifiedSource: snapshot?.hasUnclassifiedSource ?? 'unknown',
        classifiedAtMs: snapshot?.classifiedAtMs ?? 'unknown',
        deliveries: byGeneration.get(match.generationContextRef) ?? [],
      };
    },
  );
  const deliveries = generations.flatMap(generation => generation.deliveries);
  const unknownDimensions: CustodyChainUnknownDimension[] = [];
  if (generations.some(generation => generation.snapshotStatus !== 'present')) {
    unknownDimensions.push('custody_snapshot');
  }
  if (generations.some(generation => generation.deliveries.length === 0)) {
    unknownDimensions.push('egress_delivery');
  }
  const last = input.matches.at(-1);
  return {
    direction: 'source_to_egresses',
    source: input.source,
    generations,
    generationCount: generations.length,
    deliveryCount: deliveries.length,
    heldDeliveryCount: deliveries.filter(delivery => delivery.disposition === 'held').length,
    malformedDeliveryCount: input.deliveries.malformedCount,
    page: {
      limit: input.limit,
      hasMore: input.hasMore,
      ...(input.hasMore && last
        ? { nextCursor: encodeCustodyChainCursor(last.classifiedAtMs, last.turnId) }
        : {}),
    },
    unknownDimensions,
  };
}
