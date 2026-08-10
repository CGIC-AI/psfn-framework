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
// instance over the same file, the store RELOADS from disk on every operation
// and serializes each complete mutation behind a cross-process write lock —
// no cached view can go stale or overwrite a sibling process's transition.
//
// Content posture: this store is the gateway-side resolver for envelope
// content refs — the ONE place raw quarantined bytes are allowed to rest,
// outside companion reach, for operator review and release. Terminal
// discard/expire decisions scrub the raw text (and safe representation) from
// the entry; the envelope journal and content hash remain for audit.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withCrossProcessWriteLock } from '../../../persistence/sessions/cross-process-write-lock.js';
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

interface IntakeQuarantineRedeliveryRecord {
  delivered: boolean;
  attemptedAtMs: number;
  channelId?: string;
  /** Exact active logical session that received the released context. */
  logicalSessionId?: string;
  entryId?: number | null;
  reason?: string;
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
  /**
   * True when malformed optional L1 rule evidence was isolated while loading.
   * The item remains held and visible, but may only be discarded until the
   * missing audit evidence is repaired.
   */
  ruleMatchProvenanceUnavailable?: true;
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
  /** Last attempt to return released content to its carrying conversation. */
  redelivery?: IntakeQuarantineRedeliveryRecord;
  /**
   * On-disk artifact paths carrying this item's raw content (a saved document
   * and its parsed-text sidecar). Registered at hold time so read seams can
   * refuse to serve a quarantined artifact's content (hrmrq.54).
   */
  artifactPaths?: string[];
  /** Device/inode identities captured at hold time; closes hardlink/rename aliases. */
  artifactIdentities?: string[];
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

interface IntakeQuarantineRedeliveryInput extends IntakeQuarantineRedeliveryRecord {
  id: string;
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
  /** Persists the outcome of returning released content to its conversation. */
  recordRedelivery(input: IntakeQuarantineRedeliveryInput): IntakeQuarantineEntry;
  /**
   * The entry whose registered artifact paths contain `path` (normalized
   * exact match), preferring held entries when several match (hrmrq.54).
   */
  findByArtifactPath(path: string): IntakeQuarantineEntry | undefined;
  /**
   * Batch form of {@link findByArtifactPath}: resolves every path from one
   * atomic store snapshot so bounded scans do not reload the quarantine file
   * once per candidate.
   */
  findByArtifactPaths(paths: readonly string[]): Map<string, IntakeQuarantineEntry>;
  /**
   * Records one attempted read of a quarantined item's artifact (bounded to
   * the newest {@link INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS}). Throws on
   * unknown ids — an audit write must never silently miss.
   */
  recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry;
  /** Records several access attempts in one locked reload/write transaction. */
  recordAccessAttempts(
    inputs: readonly IntakeQuarantineAccessAttemptInput[],
  ): IntakeQuarantineEntry[];
  /**
   * Atomically resolves a bounded set of path aliases and records every
   * not-released match, returning verdict inputs and the exact gating-state
   * revision from the same write-locked transaction.
   */
  checkArtifactAccesses(input: IntakeQuarantineArtifactAccessBatchInput): {
    entries: Array<IntakeQuarantineEntry | undefined>;
    revisionToken: string;
  };
  /** Cheap identity token for the current artifact-read gating state. */
  readRevisionToken(): string;
  /**
   * Every registered artifact path (normalized) belonging to an entry that is
   * NOT in an operator-released sink-consumable state — the set a sandbox
   * launch must physically deny (hrmrq.54). Throws on a broken store file:
   * a caller that cannot enumerate the deny set must fail closed, not open.
   */
  listActiveArtifactPaths(): string[];
  /** Physical identities for the active paths, including reachable legacy records. */
  listActiveArtifactIdentities(): string[];
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

export interface IntakeQuarantineArtifactAccessBatchInput {
  requests: readonly {
    requestedPath: string;
    lookupPaths: readonly string[];
    lookupIdentities?: readonly string[];
  }[];
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

export type IntakeQuarantineReadStore = Pick<IntakeQuarantineStore, 'list' | 'getById'>;

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

const QUARANTINE_WRITE_LOCK_OPTIONS = {
  pollMs: 10,
  staleMs: 30_000,
  timeoutMs: 10_000,
} as const;

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
/** @internal Exported so descriptor-unlink behavior can be regression-tested deterministically. */
export function captureOpenArtifactRegistration(
  descriptor: number,
  fallbackPath: string,
): {
  path: string;
  identity: string;
} {
  const resolved = normalizeQuarantineArtifactPath(fallbackPath);
  const stats = fstatSync(descriptor, { bigint: true });
  // Resolve through the already-open descriptor. A sibling rename/symlink
  // swap cannot pair one path observation with another inode's stat.
  let canonical = resolved;
  try {
    canonical = realpathSync(`/proc/self/fd/${String(descriptor)}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    // Linux appends " (deleted)" to an unlinked proc-fd target, which
    // makes realpath fail. The descriptor's identity is still authoritative
    // (and may remain reachable through a hardlink), so retain the normalized
    // source spelling instead of abandoning the quarantine hold.
  }
  return {
    path: canonical,
    identity: `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`,
  };
}

function canonicalizeArtifactForRegistration(path: string): {
  path: string;
  identity?: string;
} {
  const resolved = normalizeQuarantineArtifactPath(path);
  let descriptor: number;
  try {
    descriptor = openSync(resolved, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: resolved };
    throw error;
  }
  try {
    return captureOpenArtifactRegistration(descriptor, resolved);
  } finally {
    closeSync(descriptor);
  }
}

function artifactIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function normalizeArtifactPathsForHold(paths: readonly string[]): {
  paths: string[];
  identities: string[];
} {
  const normalized = new Set<string>();
  const identities = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error('Intake quarantine artifact paths must be non-empty strings');
    }
    const artifact = canonicalizeArtifactForRegistration(path);
    if (artifact.path.length > MAX_ARTIFACT_PATH_CHARS) {
      throw new Error(
        `Intake quarantine artifact path exceeds ${String(MAX_ARTIFACT_PATH_CHARS)} chars`,
      );
    }
    normalized.add(artifact.path);
    if (artifact.identity) identities.add(artifact.identity);
  }
  if (normalized.size > INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS) {
    throw new Error(
      `Intake quarantine hold registered ${String(normalized.size)} artifact paths; `
      + `max ${String(INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS)}`,
    );
  }
  return { paths: [...normalized], identities: [...identities] };
}

function assertEntryShape(value: unknown, filePath: string): IntakeQuarantineEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidEntry(filePath, 'entry must be an object');
  }
  const entry = value as Record<string, unknown>;
  const knownKeys = [
    'id', 'envelope', 'ruleMatchProvenanceUnavailable', 'mode', 'rawText', 'rawTextTruncated', 'safeRepresentationText',
    'canonicalContactId', 'sourceChannelId', 'cogSecCaseId', 'heldAtMs', 'expiresAtMs',
    'status', 'decision', 'redelivery', 'artifactPaths', 'artifactIdentities', 'accessAttempts',
  ];
  const unknownKeys = Object.keys(entry).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidEntry(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (typeof entry.id !== 'string' || !entry.id.trim()) {
    throw invalidEntry(filePath, 'missing id');
  }
  let envelope: IntakeEnvelope;
  let isolatedRuleMatchProvenance = false;
  try {
    envelope = validateIntakeEnvelope(entry.envelope);
  } catch (error) {
    const rawEnvelope = entry.envelope;
    const rawDecision = typeof rawEnvelope === 'object' && rawEnvelope !== null
      && !Array.isArray(rawEnvelope)
      ? (rawEnvelope as Record<string, unknown>).decision
      : undefined;
    const ruleProvenanceKeys = [
      'ruleMatches',
      'ruleMatchTotalCount',
      'ruleMatchesTruncated',
    ] as const;
    if (typeof rawDecision !== 'object' || rawDecision === null || Array.isArray(rawDecision)
      || !ruleProvenanceKeys.some((key) => Object.prototype.hasOwnProperty.call(rawDecision, key))) {
      throw error;
    }
    const decisionWithoutRuleMatches = { ...(rawDecision as Record<string, unknown>) };
    for (const key of ruleProvenanceKeys) delete decisionWithoutRuleMatches[key];
    try {
      envelope = validateIntakeEnvelope({
        ...(rawEnvelope as Record<string, unknown>),
        decision: decisionWithoutRuleMatches,
      });
      isolatedRuleMatchProvenance = true;
    } catch {
      throw error;
    }
  }
  if (entry.ruleMatchProvenanceUnavailable !== undefined
    && entry.ruleMatchProvenanceUnavailable !== true) {
    throw invalidEntry(filePath, 'ruleMatchProvenanceUnavailable must be true when present');
  }
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
  if (entry.artifactIdentities !== undefined) {
    if (
      !Array.isArray(entry.artifactIdentities)
      || entry.artifactIdentities.some((identity) => (
        typeof identity !== 'string' || !/^\d+:\d+:\d+$/u.test(identity)
      ))
    ) {
      throw invalidEntry(filePath, 'artifactIdentities must be device:inode:birthtime strings');
    }
    if (entry.artifactIdentities.length > INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS) {
      throw invalidEntry(
        filePath,
        `artifactIdentities exceeds max ${String(INTAKE_QUARANTINE_MAX_ARTIFACT_PATHS)}`,
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
  if (entry.redelivery !== undefined) {
    if (typeof entry.redelivery !== 'object' || entry.redelivery === null
      || Array.isArray(entry.redelivery)) {
      throw invalidEntry(filePath, 'redelivery must be an object');
    }
    const redelivery = entry.redelivery as Record<string, unknown>;
    const unknownRedeliveryKeys = Object.keys(redelivery)
      .filter(key => ![
        'delivered', 'attemptedAtMs', 'channelId', 'logicalSessionId', 'entryId', 'reason',
      ].includes(key));
    if (unknownRedeliveryKeys.length > 0) {
      throw invalidEntry(filePath, `redelivery has unsupported keys: ${unknownRedeliveryKeys.join(', ')}`);
    }
    if (typeof redelivery.delivered !== 'boolean') {
      throw invalidEntry(filePath, 'redelivery.delivered must be a boolean');
    }
    if (typeof redelivery.attemptedAtMs !== 'number' || !Number.isFinite(redelivery.attemptedAtMs)) {
      throw invalidEntry(filePath, 'redelivery.attemptedAtMs must be a finite number');
    }
    if (redelivery.channelId !== undefined
      && (typeof redelivery.channelId !== 'string' || !redelivery.channelId.trim())) {
      throw invalidEntry(filePath, 'redelivery.channelId must be a non-empty string when present');
    }
    if (redelivery.logicalSessionId !== undefined
      && (typeof redelivery.logicalSessionId !== 'string' || !redelivery.logicalSessionId.trim())) {
      throw invalidEntry(filePath, 'redelivery.logicalSessionId must be a non-empty string when present');
    }
    if (redelivery.entryId !== undefined && redelivery.entryId !== null
      && (typeof redelivery.entryId !== 'number' || !Number.isInteger(redelivery.entryId))) {
      throw invalidEntry(filePath, 'redelivery.entryId must be an integer or null when present');
    }
    if (redelivery.reason !== undefined
      && (typeof redelivery.reason !== 'string' || !redelivery.reason.trim())) {
      throw invalidEntry(filePath, 'redelivery.reason must be a non-empty string when present');
    }
    if (entry.status !== 'released_raw' && entry.status !== 'released_sanitized') {
      throw invalidEntry(filePath, 'redelivery is only valid on released entries');
    }
  }
  return {
    ...(entry as unknown as IntakeQuarantineEntry),
    envelope,
    ...(isolatedRuleMatchProvenance ? { ruleMatchProvenanceUnavailable: true } : {}),
  };
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

type LazyExpiryReadMode = 'persist_transition' | 'project_only';

function createIntakeQuarantineStoreInternal(
  filePath: string,
  options: IntakeQuarantineStoreOptions,
  lazyExpiryReadMode: LazyExpiryReadMode,
): IntakeQuarantineStore {
  if (!Number.isFinite(options.itemTtlHours) || options.itemTtlHours <= 0) {
    throw new Error('Intake quarantine store requires a positive itemTtlHours');
  }
  if (!Number.isInteger(options.maxHeldItems) || options.maxHeldItems <= 0) {
    throw new Error('Intake quarantine store requires a positive integer maxHeldItems');
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.itemTtlHours * 3_600_000;
  const lockPath = `${filePath}.write-lock`;
  const gateRevisionPath = `${filePath}.gate-revision`;

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

  // Gateway, agent, and Garden mutate this same file from separate processes.
  // Serialize the complete reload → transition → persist cycle so an access
  // audit can never overwrite an operator decision (or vice versa).
  const withWriteLock = <T>(operation: () => T): T => {
    mkdirSync(dirname(filePath), { recursive: true });
    return withCrossProcessWriteLock(lockPath, QUARANTINE_WRITE_LOCK_OPTIONS, operation);
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

  const hasExpiredEntries = (entries: Map<string, IntakeQuarantineEntry>, atMs: number): boolean =>
    [...entries.values()].some(entry => entry.status === 'held' && entry.expiresAtMs <= atMs);

  // Reads remain lock-free while no TTL transition is due. Atomic rename means
  // they see a complete old or new snapshot. A due sweep is a write and must
  // reload under the same cross-process lock as every explicit mutation.
  const loadAfterLazySweep = (atMs: number): Map<string, IntakeQuarantineEntry> => {
    const entries = load();
    if (!hasExpiredEntries(entries, atMs)) return entries;
    if (lazyExpiryReadMode === 'project_only') {
      for (const [id, entry] of entries) {
        if (entry.status !== 'held' || entry.expiresAtMs > atMs) continue;
        entries.set(id, expireEntry(entry, atMs, 'quarantine TTL elapsed'));
      }
      return entries;
    }
    return withWriteLock(() => {
      const lockedEntries = load();
      sweepExpired(lockedEntries, atMs);
      return lockedEntries;
    });
  };

  /**
   * True while the entry still gates on-disk bytes: it registered artifact
   * paths, the operator has NOT released it into a sink-consumable state, and
   * it registered at least one artifact. Such an entry anchors the
   * quarantined-artifact read gate and its attempt audit (hrmrq.54): pruning
   * it would turn every subsequent read of those bytes — including an
   * unregistered hardlink/rename alias — into an ungated, unaudited serve.
   * Only an operator release clears this identity-bearing read gate.
   */
  const anchorsLiveArtifact = (entry: IntakeQuarantineEntry): boolean =>
    !isIntakeSinkConsumableState(entry.envelope.state)
    && (entry.artifactPaths?.length ?? 0) > 0;

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

  // Access-attempt audit writes share the main JSON file but do not change
  // whether an artifact is readable. Keep a separate monotonic gate revision
  // so concurrent audits do not invalidate safe searches. Gate mutations
  // advance this token BEFORE publishing the changed JSON while holding the
  // same cross-process lock; a crash can therefore cause only a conservative
  // false invalidation, never a stale allow.
  const readGateRevisionToken = (): string => {
    try {
      const token = readFileSync(gateRevisionPath, 'utf8').trim();
      if (!/^\d+$/u.test(token)) {
        throw new Error(`Invalid intake quarantine gate revision at ${gateRevisionPath}`);
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '0';
      throw error;
    }
  };
  const advanceGateRevision = (): string => {
    const next = (BigInt(readGateRevisionToken()) + 1n).toString();
    const tmpPath = `${gateRevisionPath}.tmp`;
    writeFileSync(tmpPath, `${next}\n`, 'utf8');
    renameSync(tmpPath, gateRevisionPath);
    return next;
  };

  const findArtifactMatches = (
    entries: Map<string, IntakeQuarantineEntry>,
    paths: readonly string[],
  ): Map<string, IntakeQuarantineEntry> => {
    const needles = new Set(paths.map(normalizeQuarantineArtifactPath).filter(Boolean));
    const matches = new Map<string, IntakeQuarantineEntry>();
    for (const entry of entries.values()) {
      for (const artifactPath of entry.artifactPaths ?? []) {
        if (!needles.has(artifactPath)) continue;
        const match = matches.get(artifactPath);
        // A held entry is the strongest match. Otherwise any discarded or
        // expired hold outranks a released entry: operator clearance of an
        // older item must never clear bytes retained by a later hold.
        if (!match
          || (match.status !== 'held' && entry.status === 'held')
          || (match.status === 'held' && entry.status === 'held'
            && entry.heldAtMs > match.heldAtMs)
          || (match.status !== 'held' && entry.status !== 'held'
            && isIntakeSinkConsumableState(match.envelope.state)
            && !isIntakeSinkConsumableState(entry.envelope.state))
          || (match.status !== 'held' && entry.status !== 'held'
            && isIntakeSinkConsumableState(match.envelope.state)
            === isIntakeSinkConsumableState(entry.envelope.state)
            && entry.heldAtMs > match.heldAtMs)) {
          matches.set(artifactPath, entry);
        }
      }
    }
    return matches;
  };

  const findArtifactMatch = (
    entries: Map<string, IntakeQuarantineEntry>,
    paths: readonly string[],
    identities: readonly string[],
  ): IntakeQuarantineEntry | undefined => {
    const pathSet = new Set(paths);
    const identitySet = new Set(identities);
    let match: IntakeQuarantineEntry | undefined;
    for (const entry of entries.values()) {
      const matchesPath = (entry.artifactPaths ?? []).some(path => pathSet.has(path));
      const knownIdentities = new Set(entry.artifactIdentities ?? []);
      // Upgrade pre-identity records in memory so held entries created by an
      // earlier runtime still protect hardlink aliases after deployment.
      for (const path of entry.artifactPaths ?? []) {
        const identity = artifactIdentity(path);
        if (identity) knownIdentities.add(identity);
      }
      if (entry.artifactIdentities === undefined
        && (entry.artifactPaths?.length ?? 0) > 0
        && knownIdentities.size === 0
        && !isIntakeSinkConsumableState(entry.envelope.state)) {
        throw new Error(
          `Legacy intake quarantine entry '${entry.id}' has no reachable artifact identity; `
          + 'refusing artifact access until the held path can be verified',
        );
      }
      const matchesIdentity = [...knownIdentities]
        .some(identity => identitySet.has(identity));
      if (!matchesPath && !matchesIdentity) continue;
      if (!match
        || (match.status !== 'held' && entry.status === 'held')
        || (match.status === 'held' && entry.status === 'held'
          && entry.heldAtMs > match.heldAtMs)
        || (match.status !== 'held' && entry.status !== 'held'
          && isIntakeSinkConsumableState(match.envelope.state)
          && !isIntakeSinkConsumableState(entry.envelope.state))
        || (match.status !== 'held' && entry.status !== 'held'
          && isIntakeSinkConsumableState(match.envelope.state)
          === isIntakeSinkConsumableState(entry.envelope.state)
          && entry.heldAtMs > match.heldAtMs)) {
        match = entry;
      }
    }
    return match;
  };

  return {
    hold(input: IntakeQuarantineHoldInput): IntakeQuarantineEntry {
      if (input.envelope.state !== 'quarantined') {
        throw new Error(
          `Intake quarantine hold requires an envelope in state 'quarantined', got '${input.envelope.state}'`,
        );
      }
      const atMs = input.atMs ?? now();
      const truncated = input.rawText.length > INTAKE_QUARANTINE_MAX_RAW_CHARS;
      const artifacts = input.artifactPaths !== undefined && input.artifactPaths.length > 0
        ? normalizeArtifactPathsForHold(input.artifactPaths)
        : undefined;
      return withWriteLock(() => {
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
          ...(artifacts ? { artifactPaths: artifacts.paths } : {}),
          ...(artifacts ? { artifactIdentities: artifacts.identities } : {}),
          heldAtMs: atMs,
          expiresAtMs: atMs + ttlMs,
          status: 'held',
        };
        entries.set(entry.id, entry);
        pruneTerminalHistory(entries);
        advanceGateRevision();
        persist(entries);
        return entry;
      });
    },

    list(): IntakeQuarantineEntry[] {
      const atMs = now();
      const entries = loadAfterLazySweep(atMs);
      return [...entries.values()].sort((left, right) => {
        if ((left.status === 'held') !== (right.status === 'held')) {
          return left.status === 'held' ? -1 : 1;
        }
        return right.heldAtMs - left.heldAtMs;
      });
    },

    getById(id: string): IntakeQuarantineEntry | undefined {
      const atMs = now();
      const entries = loadAfterLazySweep(atMs);
      return entries.get(id);
    },

    findByArtifactPath(path: string): IntakeQuarantineEntry | undefined {
      const needle = normalizeQuarantineArtifactPath(path);
      if (!needle) return undefined;
      return this.findByArtifactPaths([needle]).get(needle);
    },

    findByArtifactPaths(paths: readonly string[]): Map<string, IntakeQuarantineEntry> {
      if (paths.length === 0) return new Map();
      const atMs = now();
      const entries = loadAfterLazySweep(atMs);
      return findArtifactMatches(entries, paths);
    },

    listActiveArtifactPaths(): string[] {
      const atMs = now();
      const entries = loadAfterLazySweep(atMs);
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

    listActiveArtifactIdentities(): string[] {
      const atMs = now();
      const entries = loadAfterLazySweep(atMs);
      const identities = new Set<string>();
      for (const entry of entries.values()) {
        if (!entry.artifactPaths?.length) continue;
        if (isIntakeSinkConsumableState(entry.envelope.state)) continue;
        const entryIdentities = new Set(entry.artifactIdentities ?? []);
        // Pre-identity records are upgraded from a still-reachable registered
        // path. If no path survives, fail closed: there is no sound way to
        // distinguish an unregistered hardlink from an unrelated file.
        if (entry.artifactIdentities === undefined) {
          for (const path of entry.artifactPaths) {
            const identity = artifactIdentity(path);
            if (identity) entryIdentities.add(identity);
          }
          if (entryIdentities.size === 0) {
            throw new Error(
              `Legacy intake quarantine entry '${entry.id}' has no reachable artifact identity; `
              + 'refusing sandbox launch until the held path can be verified',
            );
          }
        }
        for (const identity of entryIdentities) identities.add(identity);
      }
      return [...identities];
    },

    readRevisionToken(): string {
      return readGateRevisionToken();
    },

    checkArtifactAccesses(input: IntakeQuarantineArtifactAccessBatchInput): {
      entries: Array<IntakeQuarantineEntry | undefined>;
      revisionToken: string;
    } {
      const via = input.via.trim();
      if (!via) {
        throw new Error('Intake quarantine artifact batch requires a non-empty via');
      }
      const requests = input.requests.map((request) => {
        const requestedPath = request.requestedPath.trim();
        if (!requestedPath) {
          throw new Error('Intake quarantine artifact batch requires non-empty requested paths');
        }
        const lookupPaths = request.lookupPaths
          .map(normalizeQuarantineArtifactPath)
          .filter(Boolean);
        const lookupIdentities = request.lookupIdentities === undefined
          ? []
          : request.lookupIdentities.map((identity) => identity.trim());
        if (lookupIdentities.some(identity => !/^\d+:\d+:\d+$/u.test(identity))) {
          throw new Error(
            'Intake quarantine artifact batch received an invalid device:inode:birthtime identity',
          );
        }
        if (lookupPaths.length === 0 && lookupIdentities.length === 0) {
          throw new Error(
            'Intake quarantine artifact batch requires a lookup path or physical identity',
          );
        }
        return { requestedPath, lookupPaths, lookupIdentities };
      });
      const atMs = input.atMs ?? now();
      return withWriteLock(() => {
        const entries = load();
        sweepExpired(entries, atMs);
        const matchedEntries = requests.map(request => findArtifactMatch(
          entries,
          request.lookupPaths,
          request.lookupIdentities,
        ));
        let auditChanged = false;
        for (const [index, matched] of matchedEntries.entries()) {
          if (!matched || isIntakeSinkConsumableState(matched.envelope.state)) continue;
          const current = entries.get(matched.id)!;
          const attempt: IntakeQuarantineAccessAttempt = {
            path: requests[index]!.requestedPath.slice(0, MAX_ARTIFACT_PATH_CHARS),
            via: via.slice(0, MAX_ACCESS_ATTEMPT_VIA_CHARS),
            atMs,
          };
          entries.set(current.id, {
            ...current,
            accessAttempts: [...(current.accessAttempts ?? []), attempt]
              .slice(-INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS),
          });
          auditChanged = true;
        }
        if (auditChanged) persist(entries);
        return {
          entries: matchedEntries.map(entry => entry ? entries.get(entry.id) : undefined),
          revisionToken: readGateRevisionToken(),
        };
      });
    },

    recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry {
      return this.recordAccessAttempts([input])[0]!;
    },

    recordAccessAttempts(
      inputs: readonly IntakeQuarantineAccessAttemptInput[],
    ): IntakeQuarantineEntry[] {
      if (inputs.length === 0) return [];
      const normalizedInputs = inputs.map((input) => {
        const via = input.via.trim();
        if (!via) {
          throw new Error('Intake quarantine access attempt requires a non-empty via');
        }
        const path = input.path.trim();
        if (!path) {
          throw new Error('Intake quarantine access attempt requires a non-empty path');
        }
        return {
          id: input.id,
          path: path.slice(0, MAX_ARTIFACT_PATH_CHARS),
          via: via.slice(0, MAX_ACCESS_ATTEMPT_VIA_CHARS),
          atMs: input.atMs ?? now(),
        };
      });
      return withWriteLock(() => {
        const entries = load();
        const latestAtMs = Math.max(...normalizedInputs.map(input => input.atMs));
        sweepExpired(entries, latestAtMs);
        for (const input of normalizedInputs) {
          if (!entries.has(input.id)) {
            throw new Error(`Intake quarantine entry not found: ${input.id}`);
          }
        }
        const updatedById = new Map<string, IntakeQuarantineEntry>();
        const results: IntakeQuarantineEntry[] = [];
        for (const input of normalizedInputs) {
          const entry = entries.get(input.id)!;
          const attempt: IntakeQuarantineAccessAttempt = {
            path: input.path,
            via: input.via,
            atMs: input.atMs,
          };
          const updated: IntakeQuarantineEntry = {
            ...entry,
            accessAttempts: [...(entry.accessAttempts ?? []), attempt]
              .slice(-INTAKE_QUARANTINE_MAX_ACCESS_ATTEMPTS),
          };
          entries.set(entry.id, updated);
          updatedById.set(entry.id, updated);
          results.push(updated);
        }
        persist(entries);
        return results.map(entry => updatedById.get(entry.id)!);
      });
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
      return withWriteLock(() => {
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
        if (entry.ruleMatchProvenanceUnavailable && input.action !== 'discard') {
          throw new Error(
            `Intake quarantine entry '${input.id}' rule-match provenance is unavailable; `
            + 'only discard is permitted (release fails closed)',
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
        if (isIntakeSinkConsumableState(decided.envelope.state)) {
          advanceGateRevision();
        }
        persist(entries);
        return decided;
      });
    },

    recordRedelivery(input: IntakeQuarantineRedeliveryInput): IntakeQuarantineEntry {
      if (!Number.isFinite(input.attemptedAtMs)) {
        throw new Error('Intake quarantine redelivery attemptedAtMs must be finite');
      }
      if (input.channelId !== undefined && !input.channelId.trim()) {
        throw new Error('Intake quarantine redelivery channelId must be non-empty when present');
      }
      if (input.logicalSessionId !== undefined && !input.logicalSessionId.trim()) {
        throw new Error('Intake quarantine redelivery logicalSessionId must be non-empty when present');
      }
      if (input.reason !== undefined && !input.reason.trim()) {
        throw new Error('Intake quarantine redelivery reason must be non-empty when present');
      }
      return withWriteLock(() => {
        const entries = load();
        const entry = entries.get(input.id);
        if (!entry) throw new Error(`Intake quarantine entry not found: ${input.id}`);
        if (entry.status !== 'released_raw' && entry.status !== 'released_sanitized') {
          throw new Error(
            `Intake quarantine entry '${input.id}' is '${entry.status}'; only released items record re-delivery`,
          );
        }
        const updated: IntakeQuarantineEntry = {
          ...entry,
          redelivery: {
            delivered: input.delivered,
            attemptedAtMs: input.attemptedAtMs,
            ...(input.channelId !== undefined ? { channelId: input.channelId.trim() } : {}),
            ...(input.logicalSessionId !== undefined
              ? { logicalSessionId: input.logicalSessionId.trim() }
              : {}),
            ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
            ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
          },
        };
        entries.set(entry.id, updated);
        persist(entries);
        return updated;
      });
    },
  };
}

export function createIntakeQuarantineStore(
  filePath: string,
  options: IntakeQuarantineStoreOptions,
): IntakeQuarantineStore {
  return createIntakeQuarantineStoreInternal(filePath, options, 'persist_transition');
}

/**
 * Read-only cross-process view for surfaces that do not own quarantine
 * lifecycle events. Expired entries are projected as expired with content
 * scrubbed, but the reader never persists the transition or consumes the
 * owning agent/gateway's expiry-alert responsibility.
 */
export function createIntakeQuarantineReadStore(
  filePath: string,
  options: Pick<IntakeQuarantineStoreOptions, 'itemTtlHours' | 'maxHeldItems' | 'now'>,
): IntakeQuarantineReadStore {
  const store = createIntakeQuarantineStoreInternal(filePath, options, 'project_only');
  return {
    list: () => store.list(),
    getById: id => store.getById(id),
  };
}
