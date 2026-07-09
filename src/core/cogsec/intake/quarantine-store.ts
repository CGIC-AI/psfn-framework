// ── Cognition Intake Firewall: durable quarantine store (htm9.11) ──
//
// The held-item half of the quarantine-and-release state machine. Screening
// layers (L1/L1.5 in screening.ts, L3 in l3-screener.ts) HOLD quarantined
// items here; the Garden Cognitive Security approval queue is the ONLY
// surface that resolves them (release raw / release sanitized / discard),
// always through a human decision on the envelope state machine.
//
// Storage model (pending-contact-approvals precedent, multi-process like
// cogsec-events.json): one JSON file under companion-data/state, atomic
// tmp+rename writes, fail-closed validation on load. Because the gateway
// process, the agent process, and the Garden surface each construct their own
// instance over the same file, the store RELOADS from disk on every
// operation — no cached view can go stale across processes.
//
// Content posture: this store is the gateway-side resolver for envelope
// content refs — the ONE place raw quarantined bytes are allowed to rest,
// outside companion reach, for operator review and release. Terminal
// discard/expire decisions scrub the raw text (and safe representation) from
// the entry; the envelope journal and content hash remain for audit.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  transitionIntakeEnvelope,
  validateIntakeEnvelope,
  type IntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';

export const INTAKE_QUARANTINE_CONTENT_STORE = 'intake-quarantine';

export const INTAKE_QUARANTINE_ENTRY_STATUSES = [
  'held',
  'released_raw',
  'released_sanitized',
  'discarded',
  'expired',
] as const;

export type IntakeQuarantineEntryStatus = typeof INTAKE_QUARANTINE_ENTRY_STATUSES[number];

export const INTAKE_QUARANTINE_DECISION_ACTIONS = [
  'release_raw',
  'release_sanitized',
  'discard',
] as const;

export type IntakeQuarantineDecisionAction = typeof INTAKE_QUARANTINE_DECISION_ACTIONS[number];

export interface IntakeQuarantineDecisionRecord {
  action: IntakeQuarantineDecisionAction;
  /** Acting principal, e.g. 'operator:garden'. */
  actor: string;
  reason: string;
  atMs: number;
}

export interface IntakeQuarantineEntry {
  /** The envelope id (unique across writers). */
  id: string;
  /** The envelope journal; authoritative state, validated fail-closed on load. */
  envelope: IntakeEnvelope;
  /** Firewall mode at hold time ('shadow' items were delivered, not withheld). */
  mode: 'shadow' | 'enforce';
  /** Raw held content. Scrubbed to '' on discard/expire (audit keeps the hash). */
  rawText: string;
  /** True when rawText was truncated at the storage cap. */
  rawTextTruncated: boolean;
  /**
   * Rendered L3 safe representation, when the item went through L3 and one
   * was produced. Absent ⇒ release_sanitized is UNAVAILABLE for this item
   * (explicit, never a silent fallback to raw).
   */
  safeRepresentationText?: string;
  /** Canonical contact id of the sender, when known (people-list flywheel). */
  canonicalContactId?: string;
  /** Carrying channel id, when known (CogSec event correlation). */
  sourceChannelId?: string;
  /** CogSec case written at hold time (L3 path), when one exists. */
  cogSecCaseId?: string;
  heldAtMs: number;
  /** heldAtMs + policy itemTtlHours; past this a held entry expires. */
  expiresAtMs: number;
  status: IntakeQuarantineEntryStatus;
  decision?: IntakeQuarantineDecisionRecord;
}

export interface IntakeQuarantineHoldInput {
  /** Envelope in state 'quarantined'. */
  envelope: IntakeEnvelope;
  mode: 'shadow' | 'enforce';
  rawText: string;
  safeRepresentationText?: string;
  canonicalContactId?: string;
  sourceChannelId?: string;
  cogSecCaseId?: string;
  atMs?: number;
}

/** Minimal write port handed to the screening layers. */
export interface IntakeQuarantineHoldPort {
  hold(input: IntakeQuarantineHoldInput): IntakeQuarantineEntry;
}

export interface IntakeQuarantineDecisionInput {
  id: string;
  action: IntakeQuarantineDecisionAction;
  /** Acting principal recorded on the envelope transition ('operator:garden'). */
  actor: string;
  reason: string;
  atMs?: number;
}

export interface IntakeQuarantineStore extends IntakeQuarantineHoldPort {
  /** All entries (held first, newest-held first), after a lazy TTL sweep. */
  list(): IntakeQuarantineEntry[];
  getById(id: string): IntakeQuarantineEntry | undefined;
  /**
   * Applies one human decision to a HELD entry: transitions the envelope
   * (human_released / human_released_sanitized / discarded, decidedBy
   * 'human'), records the decision, and scrubs raw content on discard.
   * Throws on unknown ids, non-held entries, and release_sanitized without a
   * safe representation (fail closed).
   */
  applyDecision(input: IntakeQuarantineDecisionInput): IntakeQuarantineEntry;
}

export interface IntakeQuarantineStoreOptions {
  /** Hours before a held item auto-expires (intake-policy quarantine.itemTtlHours). */
  itemTtlHours: number;
  /** Held-item capacity (intake-policy quarantine.maxHeldItems); oldest expire early. */
  maxHeldItems: number;
  now?: () => number;
}

/** Storage cap for held raw text; larger content is truncated with a flag. */
export const INTAKE_QUARANTINE_MAX_RAW_CHARS = 400_000;

/** Terminal entries retained for operator history beyond the held set. */
const MAX_TERMINAL_ENTRIES = 200;

const TTL_ACTOR = 'system:intake-quarantine';

interface QuarantineFileShape {
  version: 1;
  entries: IntakeQuarantineEntry[];
}

function invalidEntry(filePath: string, detail: string): Error {
  return new Error(`Invalid intake quarantine entry in ${filePath}: ${detail}`);
}

function assertEntryShape(value: unknown, filePath: string): IntakeQuarantineEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidEntry(filePath, 'entry must be an object');
  }
  const entry = value as Record<string, unknown>;
  const knownKeys = [
    'id', 'envelope', 'mode', 'rawText', 'rawTextTruncated', 'safeRepresentationText',
    'canonicalContactId', 'sourceChannelId', 'cogSecCaseId', 'heldAtMs', 'expiresAtMs',
    'status', 'decision',
  ];
  const unknownKeys = Object.keys(entry).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidEntry(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (typeof entry.id !== 'string' || !entry.id.trim()) {
    throw invalidEntry(filePath, 'missing id');
  }
  const envelope = validateIntakeEnvelope(entry.envelope);
  if (envelope.id !== entry.id) {
    throw invalidEntry(filePath, `entry id '${entry.id}' does not match envelope id '${envelope.id}'`);
  }
  if (entry.mode !== 'shadow' && entry.mode !== 'enforce') {
    throw invalidEntry(filePath, "mode must be 'shadow' or 'enforce'");
  }
  if (typeof entry.rawText !== 'string') {
    throw invalidEntry(filePath, 'rawText must be a string');
  }
  if (typeof entry.rawTextTruncated !== 'boolean') {
    throw invalidEntry(filePath, 'rawTextTruncated must be a boolean');
  }
  for (const optional of ['safeRepresentationText', 'canonicalContactId', 'sourceChannelId', 'cogSecCaseId'] as const) {
    if (entry[optional] !== undefined && typeof entry[optional] !== 'string') {
      throw invalidEntry(filePath, `${optional} must be a string when present`);
    }
  }
  for (const numeric of ['heldAtMs', 'expiresAtMs'] as const) {
    if (typeof entry[numeric] !== 'number' || !Number.isFinite(entry[numeric])) {
      throw invalidEntry(filePath, `${numeric} must be a finite number`);
    }
  }
  if (!(INTAKE_QUARANTINE_ENTRY_STATUSES as readonly string[]).includes(entry.status as string)) {
    throw invalidEntry(filePath, `status must be one of: ${INTAKE_QUARANTINE_ENTRY_STATUSES.join(', ')}`);
  }
  if (entry.status !== 'held') {
    // Terminal statuses must be backed by a terminal envelope state.
    if (envelope.state === 'quarantined') {
      throw invalidEntry(filePath, `status '${String(entry.status)}' with envelope still 'quarantined'`);
    }
  } else if (envelope.state !== 'quarantined') {
    throw invalidEntry(filePath, `status 'held' requires envelope state 'quarantined', got '${envelope.state}'`);
  }
  if (entry.decision !== undefined) {
    if (typeof entry.decision !== 'object' || entry.decision === null || Array.isArray(entry.decision)) {
      throw invalidEntry(filePath, 'decision must be an object');
    }
    const decision = entry.decision as Record<string, unknown>;
    if (!(INTAKE_QUARANTINE_DECISION_ACTIONS as readonly string[]).includes(decision.action as string)) {
      throw invalidEntry(filePath, `decision.action must be one of: ${INTAKE_QUARANTINE_DECISION_ACTIONS.join(', ')}`);
    }
    if (typeof decision.actor !== 'string' || !decision.actor.trim()) {
      throw invalidEntry(filePath, 'decision.actor must be a non-empty string');
    }
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) {
      throw invalidEntry(filePath, 'decision.reason must be a non-empty string');
    }
    if (typeof decision.atMs !== 'number' || !Number.isFinite(decision.atMs)) {
      throw invalidEntry(filePath, 'decision.atMs must be a finite number');
    }
  }
  return { ...(entry as unknown as IntakeQuarantineEntry), envelope };
}

const DECISION_TO_ENVELOPE_STATE = {
  release_raw: 'human_released',
  release_sanitized: 'human_released_sanitized',
  discard: 'discarded',
} as const;

const DECISION_TO_STATUS = {
  release_raw: 'released_raw',
  release_sanitized: 'released_sanitized',
  discard: 'discarded',
} as const;

export function createIntakeQuarantineStore(
  filePath: string,
  options: IntakeQuarantineStoreOptions,
): IntakeQuarantineStore {
  if (!Number.isFinite(options.itemTtlHours) || options.itemTtlHours <= 0) {
    throw new Error('Intake quarantine store requires a positive itemTtlHours');
  }
  if (!Number.isInteger(options.maxHeldItems) || options.maxHeldItems <= 0) {
    throw new Error('Intake quarantine store requires a positive integer maxHeldItems');
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.itemTtlHours * 3_600_000;

  // Always reload from disk: gateway, agent, and Garden each hold their own
  // instance over the same file, so a cached map would go stale.
  const load = (): Map<string, IntakeQuarantineEntry> => {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    // Fail closed on corrupt state: quarantine holds are security decisions.
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error(`Unsupported intake quarantine file shape at ${filePath}`);
    }
    const entries = new Map<string, IntakeQuarantineEntry>();
    for (const value of parsed.entries) {
      const entry = assertEntryShape(value, filePath);
      if (entries.has(entry.id)) {
        throw invalidEntry(filePath, `duplicate entry id '${entry.id}'`);
      }
      entries.set(entry.id, entry);
    }
    return entries;
  };

  const persist = (entries: Map<string, IntakeQuarantineEntry>): void => {
    const payload: QuarantineFileShape = {
      version: 1,
      entries: [...entries.values()],
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  };

  const expireEntry = (entry: IntakeQuarantineEntry, atMs: number, reason: string): IntakeQuarantineEntry => ({
    ...entry,
    envelope: transitionIntakeEnvelope(entry.envelope, {
      to: 'expired',
      actor: TTL_ACTOR,
      reason,
      atMs,
    }),
    status: 'expired',
    // Scrub content on expiry; the hash on the envelope contentRef remains.
    rawText: '',
    ...(entry.safeRepresentationText !== undefined ? { safeRepresentationText: '' } : {}),
  });

  /** Lazy TTL sweep; returns true when any entry changed (caller persists). */
  const sweepExpired = (entries: Map<string, IntakeQuarantineEntry>, atMs: number): boolean => {
    let changed = false;
    for (const [id, entry] of entries) {
      if (entry.status !== 'held' || entry.expiresAtMs > atMs) continue;
      entries.set(id, expireEntry(entry, atMs, 'quarantine TTL elapsed'));
      changed = true;
    }
    return changed;
  };

  /** Bound terminal-history growth; held entries are never pruned. */
  const pruneTerminalHistory = (entries: Map<string, IntakeQuarantineEntry>): boolean => {
    const terminal = [...entries.values()]
      .filter((entry) => entry.status !== 'held')
      .sort((left, right) => left.heldAtMs - right.heldAtMs);
    if (terminal.length <= MAX_TERMINAL_ENTRIES) return false;
    for (const entry of terminal.slice(0, terminal.length - MAX_TERMINAL_ENTRIES)) {
      entries.delete(entry.id);
    }
    return true;
  };

  return {
    hold(input: IntakeQuarantineHoldInput): IntakeQuarantineEntry {
      if (input.envelope.state !== 'quarantined') {
        throw new Error(
          `Intake quarantine hold requires an envelope in state 'quarantined', got '${input.envelope.state}'`,
        );
      }
      const atMs = input.atMs ?? now();
      const entries = load();
      sweepExpired(entries, atMs);
      if (entries.has(input.envelope.id)) {
        throw new Error(`Intake quarantine already holds envelope '${input.envelope.id}'`);
      }

      // Capacity cap: expire the oldest held entries early (fail closed on
      // review capacity, never on the hold itself — new suspects always land).
      const held = [...entries.values()]
        .filter((entry) => entry.status === 'held')
        .sort((left, right) => left.heldAtMs - right.heldAtMs);
      for (const entry of held.slice(0, Math.max(0, held.length - (options.maxHeldItems - 1)))) {
        entries.set(entry.id, expireEntry(entry, atMs, 'quarantine capacity cap reached'));
      }

      const truncated = input.rawText.length > INTAKE_QUARANTINE_MAX_RAW_CHARS;
      const entry: IntakeQuarantineEntry = {
        id: input.envelope.id,
        envelope: input.envelope,
        mode: input.mode,
        rawText: truncated ? input.rawText.slice(0, INTAKE_QUARANTINE_MAX_RAW_CHARS) : input.rawText,
        rawTextTruncated: truncated,
        ...(input.safeRepresentationText !== undefined
          ? { safeRepresentationText: input.safeRepresentationText }
          : {}),
        ...(input.canonicalContactId !== undefined ? { canonicalContactId: input.canonicalContactId } : {}),
        ...(input.sourceChannelId !== undefined ? { sourceChannelId: input.sourceChannelId } : {}),
        ...(input.cogSecCaseId !== undefined ? { cogSecCaseId: input.cogSecCaseId } : {}),
        heldAtMs: atMs,
        expiresAtMs: atMs + ttlMs,
        status: 'held',
      };
      entries.set(entry.id, entry);
      pruneTerminalHistory(entries);
      persist(entries);
      return entry;
    },

    list(): IntakeQuarantineEntry[] {
      const atMs = now();
      const entries = load();
      if (sweepExpired(entries, atMs)) {
        persist(entries);
      }
      return [...entries.values()].sort((left, right) => {
        if ((left.status === 'held') !== (right.status === 'held')) {
          return left.status === 'held' ? -1 : 1;
        }
        return right.heldAtMs - left.heldAtMs;
      });
    },

    getById(id: string): IntakeQuarantineEntry | undefined {
      const atMs = now();
      const entries = load();
      if (sweepExpired(entries, atMs)) {
        persist(entries);
      }
      return entries.get(id);
    },

    applyDecision(input: IntakeQuarantineDecisionInput): IntakeQuarantineEntry {
      const reason = input.reason.trim();
      if (!reason) {
        throw new Error('Intake quarantine decision requires a non-empty reason');
      }
      const actor = input.actor.trim();
      if (!actor) {
        throw new Error('Intake quarantine decision requires a non-empty actor');
      }
      if (!(INTAKE_QUARANTINE_DECISION_ACTIONS as readonly string[]).includes(input.action)) {
        throw new Error(
          `Intake quarantine decision action must be one of: ${INTAKE_QUARANTINE_DECISION_ACTIONS.join(', ')}`,
        );
      }
      const atMs = input.atMs ?? now();
      const entries = load();
      sweepExpired(entries, atMs);
      const entry = entries.get(input.id);
      if (!entry) {
        throw new Error(`Intake quarantine entry not found: ${input.id}`);
      }
      if (entry.status !== 'held') {
        throw new Error(
          `Intake quarantine entry '${input.id}' is '${entry.status}', not 'held'; only held items take decisions`,
        );
      }
      if (input.action === 'release_sanitized' && !entry.safeRepresentationText) {
        throw new Error(
          `Intake quarantine entry '${input.id}' has no safe representation; `
          + 'release_sanitized is unavailable for it (release raw or discard instead)',
        );
      }

      const to = DECISION_TO_ENVELOPE_STATE[input.action];
      const envelope = transitionIntakeEnvelope(entry.envelope, {
        to,
        actor,
        reason,
        atMs,
        // Human decisions are required entering human_* states and rejected
        // entering 'discarded' — the contract owns that coherence rule.
        ...(input.action === 'discard'
          ? {}
          : {
            decision: {
              action: input.action === 'release_raw' ? 'pass' : 'sanitize',
              reason,
              decidedBy: 'human',
              decidedAtMs: atMs,
            },
          }),
      });

      const decided: IntakeQuarantineEntry = {
        ...entry,
        envelope,
        status: DECISION_TO_STATUS[input.action],
        decision: { action: input.action, actor, reason, atMs },
        ...(input.action === 'discard'
          ? {
            rawText: '',
            ...(entry.safeRepresentationText !== undefined ? { safeRepresentationText: '' } : {}),
          }
          : {}),
      };
      entries.set(entry.id, decided);
      persist(entries);
      return decided;
    },
  };
}
