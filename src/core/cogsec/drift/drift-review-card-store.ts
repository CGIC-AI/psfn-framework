// ── Slow-poisoning detection: drift review card store (htm9.14) ──
//
// Durable home for the batched operator review cards the nightly drift-
// velocity lane raises. Storage model clones the intake quarantine store
// (multi-process file-JSON precedent): one JSON file under
// companion-data/state, atomic tmp+rename writes, fail-closed validation on
// load, and a RELOAD from disk on every operation because the agent-side
// scheduler lane (writer) and the Garden Cognitive Security surface
// (reader/resolver) each construct their own instance over the same file.
//
// Cards are evidence, not actions: resolving a card (acknowledge/dismiss)
// only records the operator decision. Nothing in this store — or anywhere in
// the drift lane — mutates memories, trust, or emotion state.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DRIFT_SIGNAL_IDS,
  isDriftSignalId,
  type DriftSignalId,
  type DriftSignalResult,
} from './drift-signals.js';

export const DRIFT_REVIEW_CARD_STATUSES = ['open', 'acknowledged', 'dismissed'] as const;
export type DriftReviewCardStatus = typeof DRIFT_REVIEW_CARD_STATUSES[number];

export const DRIFT_REVIEW_CARD_RESOLUTIONS = ['acknowledged', 'dismissed'] as const;
export type DriftReviewCardResolution = typeof DRIFT_REVIEW_CARD_RESOLUTIONS[number];

export interface DriftReviewCardResolutionRecord {
  resolution: DriftReviewCardResolution;
  /** Acting principal, e.g. 'operator:garden'. */
  actor: string;
  note: string;
  atMs: number;
}

export interface DriftReviewCard {
  id: string;
  schemaVersion: 1;
  /** Canonical contact id of the drifting source. */
  contactId: string;
  displayName: string;
  trustLevel: string;
  createdAtMs: number;
  /** Dedupe key: one card per (contact, local day, triggered-signal set). */
  evidenceHash: string;
  /** Max triggered signal score (card header severity). */
  compositeScore: number;
  triggeredSignalIds: DriftSignalId[];
  /** All four evaluated signals, each with serialized trajectory evidence. */
  signals: DriftSignalResult[];
  status: DriftReviewCardStatus;
  resolutionRecord?: DriftReviewCardResolutionRecord;
}

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

export type DriftReviewCardCreateResult =
  | { created: true; card: DriftReviewCard }
  | { created: false; reason: 'duplicate_evidence' | 'open_card_for_contact'; card: DriftReviewCard };

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
   * Raises a card. Idempotent by evidenceHash, and refuses to stack a second
   * OPEN card for a contact the operator has not reviewed yet (the nightly
   * lane would otherwise re-raise the same drift daily).
   */
  create(input: DriftReviewCardCreateInput): DriftReviewCardCreateResult;
  /**
   * Records the operator decision on an OPEN card. Throws on unknown ids and
   * already-resolved cards (fail closed — a decision that lands nowhere is
   * an error, not a no-op).
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

function assertSignalShape(value: unknown, filePath: string): DriftSignalResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCard(filePath, 'signal must be an object');
  }
  const signal = value as Record<string, unknown>;
  const knownKeys = ['id', 'triggered', 'score', 'summary', 'evidence'];
  const unknownKeys = Object.keys(signal).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `signal has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isDriftSignalId(signal.id)) {
    throw invalidCard(filePath, `signal.id must be one of: ${DRIFT_SIGNAL_IDS.join(', ')}`);
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
  return signal as unknown as DriftSignalResult;
}

function assertCardShape(value: unknown, filePath: string): DriftReviewCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCard(filePath, 'card must be an object');
  }
  const card = value as Record<string, unknown>;
  const knownKeys = [
    'id', 'schemaVersion', 'contactId', 'displayName', 'trustLevel', 'createdAtMs',
    'evidenceHash', 'compositeScore', 'triggeredSignalIds', 'signals', 'status', 'resolutionRecord',
  ];
  const unknownKeys = Object.keys(card).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidCard(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (card.schemaVersion !== 1) {
    throw invalidCard(filePath, 'schemaVersion must be 1');
  }
  for (const field of ['id', 'contactId', 'displayName', 'trustLevel', 'evidenceHash'] as const) {
    if (typeof card[field] !== 'string' || !(card[field] as string).trim()) {
      throw invalidCard(filePath, `${field} must be a non-empty string`);
    }
  }
  for (const numeric of ['createdAtMs', 'compositeScore'] as const) {
    if (typeof card[numeric] !== 'number' || !Number.isFinite(card[numeric])) {
      throw invalidCard(filePath, `${numeric} must be a finite number`);
    }
  }
  if (!Array.isArray(card.triggeredSignalIds) || !card.triggeredSignalIds.every(isDriftSignalId)) {
    throw invalidCard(filePath, `triggeredSignalIds must be an array of: ${DRIFT_SIGNAL_IDS.join(', ')}`);
  }
  if (!Array.isArray(card.signals)) {
    throw invalidCard(filePath, 'signals must be an array');
  }
  const signals = card.signals.map((signal) => assertSignalShape(signal, filePath));
  if (!(DRIFT_REVIEW_CARD_STATUSES as readonly string[]).includes(card.status as string)) {
    throw invalidCard(filePath, `status must be one of: ${DRIFT_REVIEW_CARD_STATUSES.join(', ')}`);
  }
  if (card.status === 'open') {
    if (card.resolutionRecord !== undefined) {
      throw invalidCard(filePath, "status 'open' must not carry a resolutionRecord");
    }
  } else {
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
  return { ...(card as unknown as DriftReviewCard), signals };
}

export function createDriftReviewCardStore(
  filePath: string,
  options: { now?: () => number } = {},
): DriftReviewCardStore {
  const now = options.now ?? Date.now;

  // Always reload from disk: the agent-side lane and the Garden surface each
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
      for (const existing of entries.values()) {
        if (existing.evidenceHash === evidenceHash) {
          return { created: false, reason: 'duplicate_evidence', card: existing };
        }
      }
      for (const existing of entries.values()) {
        if (existing.status === 'open' && existing.contactId === contactId) {
          return { created: false, reason: 'open_card_for_contact', card: existing };
        }
      }
      const card: DriftReviewCard = {
        id: randomUUID(),
        schemaVersion: 1,
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
