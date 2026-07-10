// ── Cognitive-security drift review card store (htm9.14, htm9.15) ──
//
// Durable home for the batched operator review cards the nightly drift lanes
// raise. Storage model clones the intake quarantine store (multi-process
// file-JSON precedent): one JSON file under companion-data/state, atomic
// tmp+rename writes, fail-closed validation on load, and a RELOAD from disk
// on every operation because the agent-side scheduler lanes (writers) and
// the Garden Cognitive Security surface (reader/resolver) each construct
// their own instance over the same file.
//
// Two card kinds share the store:
//  - 'source_drift' (htm9.14): per-contact slow-poisoning velocity findings.
//  - 'second_arrow' (htm9.15): self-poisoning rumination stacks — clusters
//    of near-duplicate memory writes around one topic/concern, carrying a
//    consolidation PROPOSAL.
//
// Cards are evidence, not actions: acknowledging or dismissing a card only
// records the operator decision and never mutates memories, trust, or
// emotion. The single deliberate exception is the operator-approved
// second-arrow consolidation ('consolidated'): the GARDEN resolve path — and
// only that path, after explicit operator approval — applies the card's
// proposed supersession via the existing memory-supersession machinery
// (never deletion, always audited). Nothing in the lanes or this store
// performs it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DRIFT_SIGNAL_IDS,
  isDriftSignalId,
  type DriftSignalId,
  type DriftSignalResult,
} from './drift-signals.js';
import {
  SECOND_ARROW_SIGNAL_IDS,
  isSecondArrowSignalId,
  type SecondArrowClusterMember,
  type SecondArrowSignalId,
  type SecondArrowSignalResult,
} from './second-arrow-signals.js';

export const DRIFT_REVIEW_CARD_KINDS = ['source_drift', 'second_arrow'] as const;
export type DriftReviewCardKind = typeof DRIFT_REVIEW_CARD_KINDS[number];

export const DRIFT_REVIEW_CARD_STATUSES = ['open', 'acknowledged', 'dismissed', 'consolidated'] as const;
export type DriftReviewCardStatus = typeof DRIFT_REVIEW_CARD_STATUSES[number];

export const DRIFT_REVIEW_CARD_RESOLUTIONS = ['acknowledged', 'dismissed', 'consolidated'] as const;
export type DriftReviewCardResolution = typeof DRIFT_REVIEW_CARD_RESOLUTIONS[number];

/** Resolutions valid per card kind: only second-arrow cards can consolidate. */
export const DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND: Record<
  DriftReviewCardKind,
  readonly DriftReviewCardResolution[]
> = {
  source_drift: ['acknowledged', 'dismissed'],
  second_arrow: ['acknowledged', 'dismissed', 'consolidated'],
};

export interface DriftReviewCardResolutionRecord {
  resolution: DriftReviewCardResolution;
  /** Acting principal, e.g. 'operator:garden'. */
  actor: string;
  note: string;
  atMs: number;
}

interface DriftReviewCardCommon {
  id: string;
  schemaVersion: 1;
  createdAtMs: number;
  /** Dedupe key (kind-specific derivation, see the lanes). */
  evidenceHash: string;
  /** Max triggered signal score (card header severity). */
  compositeScore: number;
  status: DriftReviewCardStatus;
  resolutionRecord?: DriftReviewCardResolutionRecord;
}

/** Per-contact slow-poisoning velocity card (htm9.14). */
export interface SourceDriftReviewCard extends DriftReviewCardCommon {
  kind: 'source_drift';
  /** Canonical contact id of the drifting source. */
  contactId: string;
  displayName: string;
  trustLevel: string;
  triggeredSignalIds: DriftSignalId[];
  /** All four evaluated signals, each with serialized trajectory evidence. */
  signals: DriftSignalResult[];
}

/**
 * The card's consolidation proposal: exactly what the operator approves.
 * `mechanism` names the existing machinery the Garden resolve path invokes —
 * supersession (updateMemory supersededBy + evolution links), never deletion.
 */
export interface SecondArrowConsolidationProposal {
  canonicalMemoryId: string;
  supersededMemoryIds: string[];
  mechanism: 'memory_supersession';
}

/** Rumination-stack card (htm9.15). */
export interface SecondArrowReviewCard extends DriftReviewCardCommon {
  kind: 'second_arrow';
  /** Preview of the canonical member's text (the card headline). */
  topicLabel: string;
  /** Deterministic cluster identity (sha256 over sorted member ids). */
  clusterKey: string;
  memberMemoryIds: string[];
  members: SecondArrowClusterMember[];
  dominantContactId?: string;
  concernId?: string;
  concernText?: string;
  triggeredSignalIds: SecondArrowSignalId[];
  signals: SecondArrowSignalResult[];
  proposedConsolidation: SecondArrowConsolidationProposal;
}

export type DriftReviewCard = SourceDriftReviewCard | SecondArrowReviewCard;

export interface DriftReviewCardCreateInput {
  contactId: string;
  displayName: string;
  trustLevel: string;
  evidenceHash: string;
  compositeScore: number;
  triggeredSignalIds: DriftSignalId[];
  signals: DriftSignalResult[];
  atMs?: number;
}

export interface SecondArrowReviewCardCreateInput {
  topicLabel: string;
  clusterKey: string;
  memberMemoryIds: string[];
  members: SecondArrowClusterMember[];
  dominantContactId?: string;
  concernId?: string;
  concernText?: string;
  evidenceHash: string;
  compositeScore: number;
  triggeredSignalIds: SecondArrowSignalId[];
  signals: SecondArrowSignalResult[];
  proposedConsolidation: SecondArrowConsolidationProposal;
  atMs?: number;
}

export type DriftReviewCardCreateResult =
  | { created: true; card: DriftReviewCard }
  | {
    created: false;
    reason: 'duplicate_evidence' | 'open_card_for_contact' | 'open_card_overlap';
    card: DriftReviewCard;
  };

export interface DriftReviewCardResolveInput {
  id: string;
  resolution: DriftReviewCardResolution;
  actor: string;
  note?: string;
  atMs?: number;
}

export interface DriftReviewCardStore {
  /** All cards, open first, newest first within each group. */
  list(): DriftReviewCard[];
  getById(id: string): DriftReviewCard | undefined;
  /**
   * Raises a source-drift card. Idempotent by evidenceHash, and refuses to
   * stack a second OPEN card for a contact the operator has not reviewed yet
   * (the nightly lane would otherwise re-raise the same drift daily).
   */
  create(input: DriftReviewCardCreateInput): DriftReviewCardCreateResult;
  /**
   * Raises a second-arrow rumination card. Idempotent by evidenceHash, and
   * refuses to stack a second OPEN second-arrow card whose cluster overlaps
   * an unreviewed one (clusters shift slightly night to night; the operator
   * should see ONE card per stack, not a card stack about a memory stack).
   */
  createSecondArrow(input: SecondArrowReviewCardCreateInput): DriftReviewCardCreateResult;
  /**
   * Records the operator decision on an OPEN card. Throws on unknown ids,
   * already-resolved cards, and kind-incompatible resolutions (only
   * second-arrow cards accept 'consolidated') — fail closed: a decision that
   * lands nowhere is an error, not a no-op.
   */
  resolve(input: DriftReviewCardResolveInput): DriftReviewCard;
}

/** Resolved cards retained for operator history beyond the open set. */
const MAX_RESOLVED_ENTRIES = 200;

interface DriftReviewFileShape {
  version: 1;
  entries: DriftReviewCard[];
}

function invalidCard(filePath: string, detail: string): Error {
  return new Error(`Invalid drift review card in ${filePath}: ${detail}`);
}

function assertSignalShape(
  value: unknown,
  filePath: string,
  isKnownId: (id: unknown) => boolean,
  knownIds: readonly string[],
): { id: string; triggered: boolean; score: number; summary: string; evidence: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCard(filePath, 'signal must be an object');
  }
  const signal = value as Record<string, unknown>;
  const knownKeys = ['id', 'triggered', 'score', 'summary', 'evidence'];
  const unknownKeys = Object.keys(signal).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `signal has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isKnownId(signal.id)) {
    throw invalidCard(filePath, `signal.id must be one of: ${knownIds.join(', ')}`);
  }
  if (typeof signal.triggered !== 'boolean') {
    throw invalidCard(filePath, 'signal.triggered must be a boolean');
  }
  if (typeof signal.score !== 'number' || !Number.isFinite(signal.score)) {
    throw invalidCard(filePath, 'signal.score must be a finite number');
  }
  if (typeof signal.summary !== 'string') {
    throw invalidCard(filePath, 'signal.summary must be a string');
  }
  if (typeof signal.evidence !== 'object' || signal.evidence === null || Array.isArray(signal.evidence)) {
    throw invalidCard(filePath, 'signal.evidence must be an object');
  }
  return signal as unknown as {
    id: string; triggered: boolean; score: number; summary: string; evidence: Record<string, unknown>;
  };
}

function assertNonEmptyStringField(
  card: Record<string, unknown>,
  field: string,
  filePath: string,
): void {
  if (typeof card[field] !== 'string' || !(card[field] as string).trim()) {
    throw invalidCard(filePath, `${field} must be a non-empty string`);
  }
}

function assertCommonShape(card: Record<string, unknown>, filePath: string): void {
  if (card.schemaVersion !== 1) {
    throw invalidCard(filePath, 'schemaVersion must be 1');
  }
  for (const field of ['id', 'evidenceHash'] as const) {
    assertNonEmptyStringField(card, field, filePath);
  }
  for (const numeric of ['createdAtMs', 'compositeScore'] as const) {
    if (typeof card[numeric] !== 'number' || !Number.isFinite(card[numeric])) {
      throw invalidCard(filePath, `${numeric} must be a finite number`);
    }
  }
  if (!(DRIFT_REVIEW_CARD_STATUSES as readonly string[]).includes(card.status as string)) {
    throw invalidCard(filePath, `status must be one of: ${DRIFT_REVIEW_CARD_STATUSES.join(', ')}`);
  }
  if (card.status === 'open') {
    if (card.resolutionRecord !== undefined) {
      throw invalidCard(filePath, "status 'open' must not carry a resolutionRecord");
    }
    return;
  }
  const record = card.resolutionRecord;
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw invalidCard(filePath, `status '${String(card.status)}' requires a resolutionRecord`);
  }
  const resolution = record as Record<string, unknown>;
  if (resolution.resolution !== card.status) {
    throw invalidCard(filePath, 'resolutionRecord.resolution must match card status');
  }
  if (typeof resolution.actor !== 'string' || !resolution.actor.trim()) {
    throw invalidCard(filePath, 'resolutionRecord.actor must be a non-empty string');
  }
  if (typeof resolution.note !== 'string') {
    throw invalidCard(filePath, 'resolutionRecord.note must be a string');
  }
  if (typeof resolution.atMs !== 'number' || !Number.isFinite(resolution.atMs)) {
    throw invalidCard(filePath, 'resolutionRecord.atMs must be a finite number');
  }
}

const SOURCE_DRIFT_KNOWN_KEYS = [
  'id', 'schemaVersion', 'kind', 'contactId', 'displayName', 'trustLevel', 'createdAtMs',
  'evidenceHash', 'compositeScore', 'triggeredSignalIds', 'signals', 'status', 'resolutionRecord',
];

function assertSourceDriftShape(card: Record<string, unknown>, filePath: string): SourceDriftReviewCard {
  const unknownKeys = Object.keys(card).filter((key) => !SOURCE_DRIFT_KNOWN_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  assertCommonShape(card, filePath);
  for (const field of ['contactId', 'displayName', 'trustLevel'] as const) {
    assertNonEmptyStringField(card, field, filePath);
  }
  if (!Array.isArray(card.triggeredSignalIds) || !card.triggeredSignalIds.every(isDriftSignalId)) {
    throw invalidCard(filePath, `triggeredSignalIds must be an array of: ${DRIFT_SIGNAL_IDS.join(', ')}`);
  }
  if (!Array.isArray(card.signals)) {
    throw invalidCard(filePath, 'signals must be an array');
  }
  const signals = card.signals.map(
    (signal) => assertSignalShape(signal, filePath, isDriftSignalId, DRIFT_SIGNAL_IDS),
  ) as unknown as DriftSignalResult[];
  return { ...(card as unknown as SourceDriftReviewCard), kind: 'source_drift', signals };
}

const SECOND_ARROW_KNOWN_KEYS = [
  'id', 'schemaVersion', 'kind', 'topicLabel', 'clusterKey', 'memberMemoryIds', 'members',
  'dominantContactId', 'concernId', 'concernText', 'createdAtMs', 'evidenceHash',
  'compositeScore', 'triggeredSignalIds', 'signals', 'proposedConsolidation',
  'status', 'resolutionRecord',
];

function assertClusterMemberShape(value: unknown, filePath: string): SecondArrowClusterMember {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCard(filePath, 'cluster member must be an object');
  }
  const member = value as Record<string, unknown>;
  const knownKeys = ['id', 'textPreview', 'type', 'extractedAtMs', 'contactId', 'sourceType', 'similarityToCentroid'];
  const unknownKeys = Object.keys(member).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `cluster member has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  for (const field of ['id', 'type'] as const) {
    assertNonEmptyStringField(member, field, filePath);
  }
  if (typeof member.textPreview !== 'string') {
    throw invalidCard(filePath, 'cluster member textPreview must be a string');
  }
  for (const numeric of ['extractedAtMs', 'similarityToCentroid'] as const) {
    if (typeof member[numeric] !== 'number' || !Number.isFinite(member[numeric])) {
      throw invalidCard(filePath, `cluster member ${numeric} must be a finite number`);
    }
  }
  for (const optional of ['contactId', 'sourceType'] as const) {
    if (member[optional] !== undefined && typeof member[optional] !== 'string') {
      throw invalidCard(filePath, `cluster member ${optional} must be a string when present`);
    }
  }
  return member as unknown as SecondArrowClusterMember;
}

function assertSecondArrowShape(card: Record<string, unknown>, filePath: string): SecondArrowReviewCard {
  const unknownKeys = Object.keys(card).filter((key) => !SECOND_ARROW_KNOWN_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  assertCommonShape(card, filePath);
  for (const field of ['topicLabel', 'clusterKey'] as const) {
    assertNonEmptyStringField(card, field, filePath);
  }
  for (const optional of ['dominantContactId', 'concernId', 'concernText'] as const) {
    if (card[optional] !== undefined && typeof card[optional] !== 'string') {
      throw invalidCard(filePath, `${optional} must be a string when present`);
    }
  }
  if (!Array.isArray(card.memberMemoryIds)
    || card.memberMemoryIds.length === 0
    || !card.memberMemoryIds.every((id) => typeof id === 'string' && id.trim())) {
    throw invalidCard(filePath, 'memberMemoryIds must be a non-empty array of non-empty strings');
  }
  if (!Array.isArray(card.members)) {
    throw invalidCard(filePath, 'members must be an array');
  }
  const members = card.members.map((member) => assertClusterMemberShape(member, filePath));
  if (!Array.isArray(card.triggeredSignalIds) || !card.triggeredSignalIds.every(isSecondArrowSignalId)) {
    throw invalidCard(filePath, `triggeredSignalIds must be an array of: ${SECOND_ARROW_SIGNAL_IDS.join(', ')}`);
  }
  if (!Array.isArray(card.signals)) {
    throw invalidCard(filePath, 'signals must be an array');
  }
  const signals = card.signals.map(
    (signal) => assertSignalShape(signal, filePath, isSecondArrowSignalId, SECOND_ARROW_SIGNAL_IDS),
  ) as unknown as SecondArrowSignalResult[];
  const proposal = card.proposedConsolidation;
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    throw invalidCard(filePath, 'proposedConsolidation must be an object');
  }
  const proposalRecord = proposal as Record<string, unknown>;
  const proposalKeys = ['canonicalMemoryId', 'supersededMemoryIds', 'mechanism'];
  const unknownProposalKeys = Object.keys(proposalRecord).filter((key) => !proposalKeys.includes(key));
  if (unknownProposalKeys.length > 0) {
    throw invalidCard(filePath, `proposedConsolidation has unsupported keys: ${unknownProposalKeys.join(', ')}`);
  }
  assertNonEmptyStringField(proposalRecord, 'canonicalMemoryId', filePath);
  if (proposalRecord.mechanism !== 'memory_supersession') {
    throw invalidCard(filePath, "proposedConsolidation.mechanism must be 'memory_supersession'");
  }
  if (!Array.isArray(proposalRecord.supersededMemoryIds)
    || proposalRecord.supersededMemoryIds.length === 0
    || !proposalRecord.supersededMemoryIds.every((id) => typeof id === 'string' && id.trim())) {
    throw invalidCard(filePath, 'proposedConsolidation.supersededMemoryIds must be a non-empty array of non-empty strings');
  }
  if (proposalRecord.supersededMemoryIds.includes(proposalRecord.canonicalMemoryId)) {
    throw invalidCard(filePath, 'proposedConsolidation must not supersede its own canonical memory');
  }
  return {
    ...(card as unknown as SecondArrowReviewCard),
    kind: 'second_arrow',
    members,
    signals,
  };
}

function assertCardShape(value: unknown, filePath: string): DriftReviewCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCard(filePath, 'card must be an object');
  }
  const card = value as Record<string, unknown>;
  // Cards written by htm9.14 (this same feature branch) predate the `kind`
  // discriminator and are all source-drift cards by construction, so an
  // absent kind is normalized — not guessed — to 'source_drift'. Any other
  // value fails closed.
  const kind = card.kind ?? 'source_drift';
  if (kind === 'source_drift') {
    return assertSourceDriftShape(card, filePath);
  }
  if (kind === 'second_arrow') {
    return assertSecondArrowShape(card, filePath);
  }
  throw invalidCard(filePath, `kind must be one of: ${DRIFT_REVIEW_CARD_KINDS.join(', ')}`);
}

export function createDriftReviewCardStore(
  filePath: string,
  options: { now?: () => number } = {},
): DriftReviewCardStore {
  const now = options.now ?? Date.now;

  // Always reload from disk: the agent-side lanes and the Garden surface each
  // hold their own instance over the same file (quarantine-store precedent).
  const load = (): Map<string, DriftReviewCard> => {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    // Fail closed on corrupt state: drift cards are security evidence.
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error(`Unsupported drift review card file shape at ${filePath}`);
    }
    const entries = new Map<string, DriftReviewCard>();
    for (const value of parsed.entries) {
      const card = assertCardShape(value, filePath);
      if (entries.has(card.id)) {
        throw invalidCard(filePath, `duplicate card id '${card.id}'`);
      }
      entries.set(card.id, card);
    }
    return entries;
  };

  const persist = (entries: Map<string, DriftReviewCard>): void => {
    const payload: DriftReviewFileShape = {
      version: 1,
      entries: [...entries.values()],
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  };

  /** Bound resolved-history growth; open cards are never pruned. */
  const pruneResolvedHistory = (entries: Map<string, DriftReviewCard>): void => {
    const resolved = [...entries.values()]
      .filter((card) => card.status !== 'open')
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
    if (resolved.length <= MAX_RESOLVED_ENTRIES) return;
    for (const card of resolved.slice(0, resolved.length - MAX_RESOLVED_ENTRIES)) {
      entries.delete(card.id);
    }
  };

  const findDuplicateEvidence = (
    entries: Map<string, DriftReviewCard>,
    evidenceHash: string,
  ): DriftReviewCard | undefined => {
    for (const existing of entries.values()) {
      if (existing.evidenceHash === evidenceHash) return existing;
    }
    return undefined;
  };

  return {
    list(): DriftReviewCard[] {
      return [...load().values()].sort((left, right) => {
        if ((left.status === 'open') !== (right.status === 'open')) {
          return left.status === 'open' ? -1 : 1;
        }
        return right.createdAtMs - left.createdAtMs;
      });
    },

    getById(id: string): DriftReviewCard | undefined {
      return load().get(id);
    },

    create(input: DriftReviewCardCreateInput): DriftReviewCardCreateResult {
      const contactId = input.contactId.trim();
      const evidenceHash = input.evidenceHash.trim();
      if (!contactId) {
        throw new Error('Drift review card requires a non-empty contactId');
      }
      if (!evidenceHash) {
        throw new Error('Drift review card requires a non-empty evidenceHash');
      }
      if (input.triggeredSignalIds.length === 0) {
        throw new Error('Drift review card requires at least one triggered signal');
      }
      const entries = load();
      const duplicate = findDuplicateEvidence(entries, evidenceHash);
      if (duplicate) {
        return { created: false, reason: 'duplicate_evidence', card: duplicate };
      }
      for (const existing of entries.values()) {
        if (existing.kind === 'source_drift' && existing.status === 'open' && existing.contactId === contactId) {
          return { created: false, reason: 'open_card_for_contact', card: existing };
        }
      }
      const card: SourceDriftReviewCard = {
        id: randomUUID(),
        schemaVersion: 1,
        kind: 'source_drift',
        contactId,
        displayName: input.displayName,
        trustLevel: input.trustLevel,
        createdAtMs: input.atMs ?? now(),
        evidenceHash,
        compositeScore: input.compositeScore,
        triggeredSignalIds: [...input.triggeredSignalIds],
        signals: [...input.signals],
        status: 'open',
      };
      entries.set(card.id, card);
      pruneResolvedHistory(entries);
      persist(entries);
      return { created: true, card };
    },

    createSecondArrow(input: SecondArrowReviewCardCreateInput): DriftReviewCardCreateResult {
      const evidenceHash = input.evidenceHash.trim();
      const clusterKey = input.clusterKey.trim();
      if (!evidenceHash) {
        throw new Error('Second-arrow review card requires a non-empty evidenceHash');
      }
      if (!clusterKey) {
        throw new Error('Second-arrow review card requires a non-empty clusterKey');
      }
      if (input.memberMemoryIds.length === 0) {
        throw new Error('Second-arrow review card requires at least one cluster member');
      }
      if (input.triggeredSignalIds.length === 0) {
        throw new Error('Second-arrow review card requires at least one triggered signal');
      }
      if (input.proposedConsolidation.supersededMemoryIds.includes(
        input.proposedConsolidation.canonicalMemoryId,
      )) {
        throw new Error('Second-arrow consolidation proposal must not supersede its own canonical memory');
      }
      const entries = load();
      const duplicate = findDuplicateEvidence(entries, evidenceHash);
      if (duplicate) {
        return { created: false, reason: 'duplicate_evidence', card: duplicate };
      }
      const inputMembers = new Set(input.memberMemoryIds);
      for (const existing of entries.values()) {
        if (existing.kind !== 'second_arrow' || existing.status !== 'open') continue;
        if (existing.memberMemoryIds.some((id) => inputMembers.has(id))) {
          return { created: false, reason: 'open_card_overlap', card: existing };
        }
      }
      const card: SecondArrowReviewCard = {
        id: randomUUID(),
        schemaVersion: 1,
        kind: 'second_arrow',
        topicLabel: input.topicLabel,
        clusterKey,
        memberMemoryIds: [...input.memberMemoryIds],
        members: [...input.members],
        ...(input.dominantContactId !== undefined ? { dominantContactId: input.dominantContactId } : {}),
        ...(input.concernId !== undefined ? { concernId: input.concernId } : {}),
        ...(input.concernText !== undefined ? { concernText: input.concernText } : {}),
        createdAtMs: input.atMs ?? now(),
        evidenceHash,
        compositeScore: input.compositeScore,
        triggeredSignalIds: [...input.triggeredSignalIds],
        signals: [...input.signals],
        proposedConsolidation: {
          canonicalMemoryId: input.proposedConsolidation.canonicalMemoryId,
          supersededMemoryIds: [...input.proposedConsolidation.supersededMemoryIds],
          mechanism: 'memory_supersession',
        },
        status: 'open',
      };
      entries.set(card.id, card);
      pruneResolvedHistory(entries);
      persist(entries);
      return { created: true, card };
    },

    resolve(input: DriftReviewCardResolveInput): DriftReviewCard {
      const actor = input.actor.trim();
      if (!actor) {
        throw new Error('Drift review card resolution requires a non-empty actor');
      }
      if (!(DRIFT_REVIEW_CARD_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
        throw new Error(
          `Drift review card resolution must be one of: ${DRIFT_REVIEW_CARD_RESOLUTIONS.join(', ')}`,
        );
      }
      const entries = load();
      const card = entries.get(input.id);
      if (!card) {
        throw new Error(`Drift review card not found: ${input.id}`);
      }
      if (card.status !== 'open') {
        throw new Error(
          `Drift review card '${input.id}' is '${card.status}', not 'open'; only open cards take decisions`,
        );
      }
      if (!DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND[card.kind].includes(input.resolution)) {
        throw new Error(
          `Drift review card '${input.id}' (kind '${card.kind}') does not accept resolution '${input.resolution}'; `
          + `allowed: ${DRIFT_REVIEW_CARD_RESOLUTIONS_BY_KIND[card.kind].join(', ')}`,
        );
      }
      const atMs = input.atMs ?? now();
      const resolved: DriftReviewCard = {
        ...card,
        status: input.resolution,
        resolutionRecord: {
          resolution: input.resolution,
          actor,
          note: input.note?.trim() ?? '',
          atMs,
        },
      };
      entries.set(card.id, resolved);
      persist(entries);
      return resolved;
    },
  };
}
