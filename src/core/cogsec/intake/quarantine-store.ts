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

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isIntakeSinkConsumableState,
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

/**
 * One recorded attempt to read a quarantined item's on-disk artifact while
 * the item was NOT operator-released (hrmrq.54). Surfaced in the Garden
 * Cognitive Security queue so a containment bypass attempt is never invisible
 * to the operator reviewing the case.
 */
export interface IntakeQuarantineAccessAttempt {
  /** The artifact path whose read was attempted. */
  path: string;
  /** Auditable access seam, e.g. 'gateway:fs.read'. */
  via: string;
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
  /**
   * On-disk artifact paths carrying this item's raw content (a saved document
   * and its parsed-text sidecar). Registered at hold time so read seams can
   * refuse to serve a quarantined artifact's content (hrmrq.54).
   */
  artifactPaths?: string[];
  /** Attempted artifact reads while the item was not released (bounded, newest last). */
  accessAttempts?: IntakeQuarantineAccessAttempt[];
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
  /** On-disk artifact paths carrying this item's raw content (hrmrq.54). */
  artifactPaths?: readonly string[];
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
  /**
   * The entry whose registered artifact paths contain `path` (normalized
   * exact match), preferring held entries when several match (hrmrq.54).
   */
  findByArtifactPath(path: string): IntakeQuarantineEntry | undefined;
  /**
   * Records one attempted read of a quarantined item's artifact (bounded to
   * the newest {@link INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS}). Throws on
   * unknown ids — an audit write must never silently miss.
   */
  recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry;
  /**
   * Every registered artifact path (normalized) belonging to an entry that is
   * NOT in an operator-released sink-consumable state — the set a sandbox
   * launch must physically deny (hrmrq.54). Throws on a broken store file:
   * a caller that cannot enumerate the deny set must fail closed, not open.
   */
  listActiveArtifactPaths(): string[];
}

export interface IntakeQuarantineAccessAttemptInput {
  /** The envelope/entry id whose artifact was requested. */
  id: string;
  /** The artifact path whose read was attempted. */
  path: string;
  /** Auditable access seam, e.g. 'gateway:fs.read'. */
  via: string;
  atMs?: number;
}

export interface IntakeQuarantineStoreOptions {
  /** Hours before a held item auto-expires (intake-policy quarantine.itemTtlHours). */
  itemTtlHours: number;
  /** Held-item capacity (intake-policy quarantine.maxHeldItems); oldest expire early. */
  maxHeldItems: number;
  now?: () => number;
  /** Called for each lazy TTL expiry after the transition is durably persisted. */
  onExpired?: (event: {
    entry: IntakeQuarantineEntry;
    expiredAtMs: number;
    reason: string;
  }) => void;
}

/** Storage cap for held raw text; larger content is truncated with a flag. */
export const INTAKE_QUARANTINE_MAX_RAW_CHARS = 400_000;

/** Cap on registered artifact paths per entry (a document + its sidecars). */
export const INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS = 16;

/** Cap on recorded artifact access attempts per entry (newest kept). */
export const INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS = 50;

const MAX_ARTIFACT_PATH_CHARS = 2_048;
const MAX_ACCESS_ATTEMPT_VIA_CHARS = 256;

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

/**
 * Canonical form for artifact-path registration and lookup: absolute,
 * `path.resolve`-normalized. Lookup and registration MUST agree on this form
 * or the read gate silently misses (hrmrq.54).
 */
export function normalizeQuarantineArtifactPath(path: string): string {
  return resolve(path.trim());
}

/**
 * Registration-time canonical form: resolve()-normalized AND realpathed when
 * the file exists. Registration must store the CANONICAL path — a hold made
 * through a symlinked prefix would otherwise register the symlink form, and
 * a read of the real path would miss both the direct lookup and the guard's
 * realpath fallback (which canonicalizes the READ path, not the stored one).
 * A missing/unresolvable file keeps the resolve()-normalized form.
 */
function canonicalizeArtifactPathForRegistration(path: string): string {
  const resolved = normalizeQuarantineArtifactPath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeArtifactPathsForHold(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error('Intake quarantine artifact paths must be non-empty strings');
    }
    const canonical = canonicalizeArtifactPathForRegistration(path);
    if (canonical.length > MAX_ARTIFACT_PATH_CHARS) {
      throw new Error(
        `Intake quarantine artifact path exceeds ${String(MAX_ARTIFACT_PATH_CHARS)} chars`,
      );
    }
    normalized.add(canonical);
  }
  if (normalized.size > INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS) {
    throw new Error(
      `Intake quarantine hold registered ${String(normalized.size)} artifact paths; `
      + `max ${String(INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS)}`,
    );
  }
  return [...normalized];
}

function assertEntryShape(value: unknown, filePath: string): IntakeQuarantineEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidEntry(filePath, 'entry must be an object');
  }
  const entry = value as Record<string, unknown>;
  const knownKeys = [
    'id', 'envelope', 'mode', 'rawText', 'rawTextTruncated', 'safeRepresentationText',
    'canonicalContactId', 'sourceChannelId', 'cogSecCaseId', 'heldAtMs', 'expiresAtMs',
    'status', 'decision', 'artifactPaths', 'accessAttempts',
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
  if (entry.artifactPaths !== undefined) {
    if (
      !Array.isArray(entry.artifactPaths)
      || entry.artifactPaths.some((path) => typeof path !== 'string' || !path.trim())
    ) {
      throw invalidEntry(filePath, 'artifactPaths must be an array of non-empty strings');
    }
    if (entry.artifactPaths.length > INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS) {
      throw invalidEntry(
        filePath,
        `artifactPaths exceeds max ${String(INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS)}`,
      );
    }
  }
  if (entry.accessAttempts !== undefined) {
    if (!Array.isArray(entry.accessAttempts)) {
      throw invalidEntry(filePath, 'accessAttempts must be an array');
    }
    for (const attempt of entry.accessAttempts) {
      if (typeof attempt !== 'object' || attempt === null || Array.isArray(attempt)) {
        throw invalidEntry(filePath, 'accessAttempts entries must be objects');
      }
      const record = attempt as Record<string, unknown>;
      if (typeof record.path !== 'string' || !record.path.trim()) {
        throw invalidEntry(filePath, 'accessAttempts entries require a non-empty path');
      }
      if (typeof record.via !== 'string' || !record.via.trim()) {
        throw invalidEntry(filePath, 'accessAttempts entries require a non-empty via');
      }
      if (typeof record.atMs !== 'number' || !Number.isFinite(record.atMs)) {
        throw invalidEntry(filePath, 'accessAttempts entries require a finite atMs');
      }
    }
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

  /** Lazy TTL sweep; durably persists before publishing expiry notifications. */
  // Returns true when at least one entry expired (callers persist and may
  // notify); fires the TTL-expiry alert hook per expired entry (hrmrq.71).
  const sweepExpired = (entries: Map<string, IntakeQuarantineEntry>, atMs: number): boolean => {
    const expiredEvents: Array<Parameters<NonNullable<IntakeQuarantineStoreOptions['onExpired']>>[0]> = [];
    for (const [id, entry] of entries) {
      if (entry.status !== 'held' || entry.expiresAtMs > atMs) continue;
      const reason = 'quarantine TTL elapsed';
      const expired = expireEntry(entry, atMs, reason);
      entries.set(id, expired);
      expiredEvents.push({ entry: expired, expiredAtMs: atMs, reason });
    }
    if (expiredEvents.length === 0) return false;
    persist(entries);
    for (const event of expiredEvents) {
      options.onExpired?.(event);
    }
    return true;
  };

  /**
   * True while the entry still gates on-disk bytes: it registered artifact
   * paths, the operator has NOT released it into a sink-consumable state, and
   * at least one artifact still exists. Such an entry anchors the
   * quarantined-artifact read gate and its attempt audit (hrmrq.54): pruning
   * it would turn every subsequent read of those bytes into an ungated,
   * unaudited serve. It becomes prunable once the artifacts are gone or the
   * operator released the item (released reads are cleared anyway).
   */
  const anchorsLiveArtifact = (entry: IntakeQuarantineEntry): boolean =>
    !isIntakeSinkConsumableState(entry.envelope.state)
    && (entry.artifactPaths ?? []).some((path) => existsSync(path));

  /**
   * Bound terminal-history growth; held entries are never pruned, and
   * terminal entries whose registered artifacts still exist on disk are
   * exempt from the cap (read-gate anchors, see anchorsLiveArtifact).
   */
  const pruneTerminalHistory = (entries: Map<string, IntakeQuarantineEntry>): boolean => {
    const terminal = [...entries.values()]
      .filter((entry) => entry.status !== 'held' && !anchorsLiveArtifact(entry))
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
      const artifactPaths = input.artifactPaths !== undefined && input.artifactPaths.length > 0
        ? normalizeArtifactPathsForHold(input.artifactPaths)
        : undefined;
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
        ...(artifactPaths ? { artifactPaths } : {}),
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
      sweepExpired(entries, atMs);
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
      sweepExpired(entries, atMs);
      return entries.get(id);
    },

    findByArtifactPath(path: string): IntakeQuarantineEntry | undefined {
      const needle = normalizeQuarantineArtifactPath(path);
      if (!needle) return undefined;
      const atMs = now();
      const entries = load();
      if (sweepExpired(entries, atMs)) {
        persist(entries);
      }
      let match: IntakeQuarantineEntry | undefined;
      for (const entry of entries.values()) {
        if (!entry.artifactPaths?.includes(needle)) continue;
        // Prefer a held entry when several entries registered the same path
        // (a released copy never masks a live hold — fail closed).
        if (entry.status === 'held') return entry;
        match ??= entry;
      }
      return match;
    },

    listActiveArtifactPaths(): string[] {
      const atMs = now();
      const entries = load();
      if (sweepExpired(entries, atMs)) {
        persist(entries);
      }
      const paths = new Set<string>();
      for (const entry of entries.values()) {
        if (!entry.artifactPaths?.length) continue;
        // Operator-released items are cleared for reads; everything else
        // (held, expired, discarded) stays in the physical deny set.
        if (isIntakeSinkConsumableState(entry.envelope.state)) continue;
        for (const path of entry.artifactPaths) paths.add(path);
      }
      return [...paths];
    },

    recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry {
      const via = input.via.trim();
      if (!via) {
        throw new Error('Intake quarantine access attempt requires a non-empty via');
      }
      const path = input.path.trim();
      if (!path) {
        throw new Error('Intake quarantine access attempt requires a non-empty path');
      }
      const atMs = input.atMs ?? now();
      const entries = load();
      sweepExpired(entries, atMs);
      const entry = entries.get(input.id);
      if (!entry) {
        throw new Error(`Intake quarantine entry not found: ${input.id}`);
      }
      const attempt: IntakeQuarantineAccessAttempt = {
        path: path.slice(0, MAX_ARTIFACT_PATH_CHARS),
        via: via.slice(0, MAX_ACCESS_ATTEMPT_VIA_CHARS),
        atMs,
      };
      const attempts = [...(entry.accessAttempts ?? []), attempt]
        .slice(-INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS);
      const updated: IntakeQuarantineEntry = { ...entry, accessAttempts: attempts };
      entries.set(entry.id, updated);
      persist(entries);
      return updated;
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
