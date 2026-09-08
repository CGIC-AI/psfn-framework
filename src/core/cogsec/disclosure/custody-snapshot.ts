// ── Durable per-turn custody snapshot (psfn-framework-ccgdz.1) ──
//
// `buildGenerationDisclosureLineage` already answers "which sources were
// admitted into the context that produced this generation?" once per turn
// (src/core/agent/substrate-agent/turn-execution-runtime.ts). Until this
// module the answer was only `log.debug`'d and published in-process, so no
// egress claim was provable after the turn ended.
//
// A `CustodySnapshot` is the durable serialization of that fold. It mints NO
// new identifier: the key is the lineage's own `generationContextRef`, which
// is literally `turn:<turnId>`.
//
// CONTENT-FREE BY CONSTRUCTION, not by convention (design §4). Every field is
// an id, a hash, a count, a boolean, a closed-vocabulary label, a version, or
// a timestamp. The lineage's refs are free-form runtime strings (`memory:<id>`,
// `project:<id>:<artifactRef>`, ...), so every one of them goes through
// `custodyIdentity`: the sha256 is always stored and is the join key, and the
// literal is retained ONLY when it is a bounded token that structurally cannot
// carry prose, a path, or a message body. That is what makes the content-free
// assertion testable rather than asserted.

import { createHash } from 'node:crypto';

import { canonicalJsonString } from '../../../shared/utils/json-serialization.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  validateToolResultCustodyEdge,
  type ToolResultCustodyEdge,
} from '../../../shared/contracts/tool-result-custody.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../system/trust/types.js';
import {
  DISCLOSURE_DESTINATION_KINDS,
  isDisclosureClassification,
  isDisclosureDestinationKind,
  type DisclosureClassification,
  type DisclosureDestinationKind,
  type DisclosureLineage,
} from './contracts.js';

const CUSTODY_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Closed source-kind vocabulary, derived from the ref prefixes the lineage
 * builders emit (`session:`, `memory:`, `bio:`, `wiki:`, `project:`, `tool:`).
 * An unrecognized prefix is `other` — never the raw prefix, so a ref can never
 * widen this vocabulary from runtime data.
 */
const CUSTODY_SOURCE_KINDS = [
  'session',
  'memory',
  'biography',
  'wiki',
  'project',
  'tool',
  'other',
] as const;

type CustodySourceKind = typeof CUSTODY_SOURCE_KINDS[number];

function isCustodySourceKind(value: unknown): value is CustodySourceKind {
  return typeof value === 'string'
    && (CUSTODY_SOURCE_KINDS as readonly string[]).includes(value);
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * A literal reference is retained only when it matches this shape: a bounded
 * run of identifier/id-punctuation characters. No whitespace, no slash, no
 * quote, no newline — so a path, a sentence, or a message body can never be
 * mistaken for an id and stored verbatim.
 */
const CUSTODY_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

/** Compile-time version labels (`disclosure/v1`) additionally allow a slash. */
const CUSTODY_VERSION_LABEL_PATTERN = /^[A-Za-z0-9_./-]{1,64}$/u;

/** Bounded identity for one runtime reference: always a hash, sometimes an id. */
export interface CustodyIdentity {
  /** sha256 of the exact original reference string; the durable join key. */
  readonly digest: string;
  /** The literal reference, retained only when structurally safe to store. */
  readonly id?: string;
}

/** One admitted source's content-free custody row. */
interface CustodySnapshotSource {
  readonly kind: CustodySourceKind;
  readonly ref: CustodyIdentity;
  readonly sensitivity: SensitivityLevel;
  /** False when the source carried no usable lineage (§9.5 fail-closed input). */
  readonly classified: boolean;
  readonly permittedDestinationKinds: readonly DisclosureDestinationKind[];
  readonly subjectContactCount: number;
  readonly sourceChannel?: CustodyIdentity;
  /** Present only for tool-result sources (psfn-framework-ccgdz.5). */
  readonly toolResult?: ToolResultCustodyEdge;
}

/**
 * The durable serialization of one turn's `DisclosureLineage`, keyed by the
 * lineage's own `generationContextRef` (`turn:<turnId>`).
 */
export interface CustodySnapshot {
  readonly schemaVersion: typeof CUSTODY_SNAPSHOT_SCHEMA_VERSION;
  readonly generationContextRef: string;
  readonly turnId: string;
  readonly requestId: CustodyIdentity;
  readonly classification: DisclosureClassification;
  readonly effectiveSensitivity: SensitivityLevel;
  /** The lineage's own admitted-source count; zero means fail closed (§9.5). */
  readonly sourceCount: number;
  readonly hasUnclassifiedSource: boolean;
  readonly classifierVersion: string;
  readonly classifiedAtMs: number;
  readonly permittedDestinationKinds: readonly DisclosureDestinationKind[];
  readonly subjectContactCount: number;
  readonly sourceChannelCount: number;
  readonly sources: readonly CustodySnapshotSource[];
}

/** The custody-snapshot key for a turn. No new identifier is minted. */
export function custodySnapshotRefForTurn(turnId: string): string {
  const trimmed = turnId.trim();
  if (trimmed.length === 0) {
    throw new Error('Custody snapshot ref requires a non-empty turn id');
  }
  return `turn:${trimmed}`;
}

export function custodySha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Bound one free-form runtime reference. The digest is unconditional; the
 * literal survives only when it is a bounded safe token. Shared with the egress
 * delivery record (psfn-framework-ccgdz.6) so every content-free custody row
 * reduces a runtime string exactly one way.
 */
export function custodyIdentity(reference: string): CustodyIdentity {
  const digest = custodySha256(reference);
  return CUSTODY_SAFE_IDENTIFIER_PATTERN.test(reference)
    ? { digest, id: reference }
    : { digest };
}

function custodySourceKindForRef(reference: string): CustodySourceKind {
  const separator = reference.indexOf(':');
  const prefix = separator < 0 ? reference : reference.slice(0, separator);
  switch (prefix) {
    case 'session': return 'session';
    case 'memory': return 'memory';
    case 'bio':
    case 'biography': return 'biography';
    case 'wiki': return 'wiki';
    case 'project': return 'project';
    case 'tool': return 'tool';
    default: return 'other';
  }
}

function uniqueDestinationKinds(
  kinds: Iterable<DisclosureDestinationKind>,
): DisclosureDestinationKind[] {
  const present = new Set<DisclosureDestinationKind>(kinds);
  // Emitted in the contract's declared order so the canonical digest is stable
  // regardless of the order sources were folded in.
  return DISCLOSURE_DESTINATION_KINDS.filter(kind => present.has(kind));
}

/**
 * Serialize one folded lineage into its durable custody snapshot.
 *
 * `toolResultEdges` binds tool-result sources to the envelope/result-hash
 * evidence collected while recording tool observations
 * (psfn-framework-ccgdz.5). It is keyed by the EXACT lineage source ref the
 * fold used, so the key and the ref cannot drift apart. A tool-result source
 * with no matching edge simply carries none — the lineage still records that
 * the source contributed.
 */
export function buildCustodySnapshot(input: {
  lineage: DisclosureLineage;
  turnId: string;
  requestId: string;
  toolResultEdges?: ReadonlyMap<string, ToolResultCustodyEdge>;
  classifiedAtMs?: number;
}): CustodySnapshot {
  const { lineage } = input;
  const expectedRef = custodySnapshotRefForTurn(input.turnId);
  if (lineage.generationContextRef !== expectedRef) {
    throw new Error(
      `Custody snapshot generationContextRef ${lineage.generationContextRef} does not match turn ${input.turnId}`,
    );
  }
  const edgesByRef = input.toolResultEdges;
  const parsedClassifiedAt = Date.parse(lineage.classifiedAt);
  if (input.classifiedAtMs === undefined && !Number.isFinite(parsedClassifiedAt)) {
    // Substituting "now" would date the record to when it was written rather
    // than when the context was classified — a silent fallback in an audit
    // trail. The caller turns this into a visible absent ref instead.
    throw new Error(
      `Custody snapshot classifiedAt ${lineage.classifiedAt} is not a parseable instant`,
    );
  }
  const classifiedAtMs = input.classifiedAtMs ?? parsedClassifiedAt;
  const sources = lineage.sourceSnapshots.map((snapshot): CustodySnapshotSource => {
    const edge = edgesByRef?.get(snapshot.ref);
    return {
      kind: custodySourceKindForRef(snapshot.ref),
      ref: custodyIdentity(snapshot.ref),
      sensitivity: snapshot.sensitivity,
      classified: snapshot.classified,
      permittedDestinationKinds: uniqueDestinationKinds(
        snapshot.permittedDestinations.map(constraint => constraint.kind),
      ),
      subjectContactCount: snapshot.subjectContactIds.length,
      ...(snapshot.sourceChannelId !== undefined
        ? { sourceChannel: custodyIdentity(snapshot.sourceChannelId) }
        : {}),
      ...(edge ? { toolResult: edge } : {}),
    };
  });
  return validateCustodySnapshot({
    schemaVersion: CUSTODY_SNAPSHOT_SCHEMA_VERSION,
    generationContextRef: lineage.generationContextRef,
    turnId: input.turnId,
    requestId: custodyIdentity(input.requestId),
    classification: lineage.classification,
    effectiveSensitivity: lineage.effectiveSensitivity,
    sourceCount: lineage.sourceCount,
    hasUnclassifiedSource: lineage.hasUnclassifiedSource,
    classifierVersion: lineage.classifierVersion,
    classifiedAtMs,
    permittedDestinationKinds: uniqueDestinationKinds(
      lineage.permittedDestinations.map(constraint => constraint.kind),
    ),
    subjectContactCount: lineage.subjectContactIds.length,
    sourceChannelCount: lineage.sourceChannelIds.length,
    sources,
  });
}

/**
 * The identity digest of a snapshot's CONTENT, deliberately excluding
 * `classifiedAtMs`. A recovered/replayed turn re-folds the same lineage at a
 * new wall-clock instant; comparing on content alone lets the store recognize
 * an identical re-write instead of reporting a spurious divergence.
 */
export function custodySnapshotContentDigest(snapshot: CustodySnapshot): string {
  const { classifiedAtMs: _classifiedAtMs, ...content } = snapshot;
  return createHash('sha256')
    .update(canonicalJsonString(content, 'custody snapshot'), 'utf8')
    .digest('hex');
}

function invalid(field: string, requirement: string): Error {
  return new Error(`Custody snapshot ${field} ${requirement}`);
}

export function validateCustodyIdentity(value: unknown, field: string): CustodyIdentity {
  if (!isRecord(value)) throw invalid(field, 'must be an object');
  if (typeof value.digest !== 'string' || !SHA256_HEX_PATTERN.test(value.digest)) {
    throw invalid(`${field}.digest`, 'must be 64 lowercase hex characters');
  }
  if (value.id === undefined) return { digest: value.digest };
  if (typeof value.id !== 'string' || !CUSTODY_SAFE_IDENTIFIER_PATTERN.test(value.id)) {
    throw invalid(`${field}.id`, 'must be a bounded safe identifier');
  }
  if (custodySha256(value.id) !== value.digest) {
    throw invalid(`${field}.id`, 'does not match its digest');
  }
  return { digest: value.digest, id: value.id };
}

function validateCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(field, 'must be a non-negative safe integer');
  }
  return value as number;
}

function validateDestinationKinds(
  value: unknown,
  field: string,
): DisclosureDestinationKind[] {
  if (!Array.isArray(value)) throw invalid(field, 'must be an array');
  for (const entry of value) {
    if (!isDisclosureDestinationKind(entry)) {
      throw invalid(field, 'must contain only known disclosure destination kinds');
    }
  }
  return uniqueDestinationKinds(value as DisclosureDestinationKind[]);
}

function validateSource(value: unknown, index: number): CustodySnapshotSource {
  const field = `sources[${index}]`;
  if (!isRecord(value)) throw invalid(field, 'must be an object');
  if (!isCustodySourceKind(value.kind)) {
    throw invalid(`${field}.kind`, 'must be a known custody source kind');
  }
  if (!VALID_SENSITIVITY_LEVELS.includes(value.sensitivity as SensitivityLevel)) {
    throw invalid(`${field}.sensitivity`, 'must be a known sensitivity level');
  }
  if (typeof value.classified !== 'boolean') {
    throw invalid(`${field}.classified`, 'must be a boolean');
  }
  return {
    kind: value.kind,
    ref: validateCustodyIdentity(value.ref, `${field}.ref`),
    sensitivity: value.sensitivity as SensitivityLevel,
    classified: value.classified,
    permittedDestinationKinds: validateDestinationKinds(
      value.permittedDestinationKinds,
      `${field}.permittedDestinationKinds`,
    ),
    subjectContactCount: validateCount(
      value.subjectContactCount,
      `${field}.subjectContactCount`,
    ),
    ...(value.sourceChannel !== undefined
      ? { sourceChannel: validateCustodyIdentity(value.sourceChannel, `${field}.sourceChannel`) }
      : {}),
    ...(value.toolResult !== undefined
      ? { toolResult: validateToolResultCustodyEdge(value.toolResult, `${field}.toolResult`) }
      : {}),
  };
}

/**
 * Re-validate a snapshot on every read as well as every write (the
 * `validateCogSecReceipt` posture): a row edited in the database is a load
 * failure, not a quiet custody claim.
 */
export function validateCustodySnapshot(value: unknown): CustodySnapshot {
  if (!isRecord(value)) throw invalid('record', 'must be an object');
  if (value.schemaVersion !== CUSTODY_SNAPSHOT_SCHEMA_VERSION) {
    throw invalid('schemaVersion', `must be ${CUSTODY_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (typeof value.turnId !== 'string'
    || !CUSTODY_SAFE_IDENTIFIER_PATTERN.test(value.turnId)) {
    throw invalid('turnId', 'must be a bounded safe identifier');
  }
  if (value.generationContextRef !== custodySnapshotRefForTurn(value.turnId)) {
    throw invalid('generationContextRef', 'must be turn:<turnId>');
  }
  if (!isDisclosureClassification(value.classification)) {
    throw invalid('classification', 'must be a known disclosure classification');
  }
  if (!VALID_SENSITIVITY_LEVELS.includes(value.effectiveSensitivity as SensitivityLevel)) {
    throw invalid('effectiveSensitivity', 'must be a known sensitivity level');
  }
  if (typeof value.hasUnclassifiedSource !== 'boolean') {
    throw invalid('hasUnclassifiedSource', 'must be a boolean');
  }
  if (typeof value.classifierVersion !== 'string'
    || !CUSTODY_VERSION_LABEL_PATTERN.test(value.classifierVersion)) {
    throw invalid('classifierVersion', 'must be a bounded safe identifier');
  }
  if (!Number.isSafeInteger(value.classifiedAtMs) || (value.classifiedAtMs as number) <= 0) {
    throw invalid('classifiedAtMs', 'must be a positive safe integer');
  }
  if (!Array.isArray(value.sources)) throw invalid('sources', 'must be an array');
  return {
    schemaVersion: CUSTODY_SNAPSHOT_SCHEMA_VERSION,
    generationContextRef: value.generationContextRef,
    turnId: value.turnId,
    requestId: validateCustodyIdentity(value.requestId, 'requestId'),
    classification: value.classification,
    effectiveSensitivity: value.effectiveSensitivity as SensitivityLevel,
    sourceCount: validateCount(value.sourceCount, 'sourceCount'),
    hasUnclassifiedSource: value.hasUnclassifiedSource,
    classifierVersion: value.classifierVersion,
    classifiedAtMs: value.classifiedAtMs as number,
    permittedDestinationKinds: validateDestinationKinds(
      value.permittedDestinationKinds,
      'permittedDestinationKinds',
    ),
    subjectContactCount: validateCount(value.subjectContactCount, 'subjectContactCount'),
    sourceChannelCount: validateCount(value.sourceChannelCount, 'sourceChannelCount'),
    sources: value.sources.map((source, index) => validateSource(source, index)),
  };
}

/** Outcome of recording one snapshot; the caller decides how loud to be. */
export type CustodySnapshotRecordOutcome =
  /** First write for this generation context. */
  | 'recorded'
  /** An identical snapshot already stood; the write was a no-op. */
  | 'duplicate'
  /**
   * A DIFFERENT snapshot already stood for this generation context. The stored
   * one is kept — it is the fold that actually produced the delivered reply —
   * and the caller must surface the divergence rather than overwrite it.
   */
  | 'diverged';

/** Durable custody-snapshot sink. */
export interface CustodySnapshotStorePort {
  record(snapshot: CustodySnapshot): Promise<CustodySnapshotRecordOutcome>;
  getByGenerationContextRef(ref: string): Promise<CustodySnapshot | null>;
  close(): Promise<void>;
}
