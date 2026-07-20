// ── CogSec publication review: durable Share Capsule custody (bible §10.10–10.11) ──
//
// jp36.7.1.2 completes jp36.7.1: it takes the pure capsule CONTRACT layer
// (`./capsule.ts`, jp36.7.1.1) and gives its state a durable, server-side home
// that rides the EXISTING egress/approval architecture (bible §10.10 "Settled",
// adjudication R1/R8: "No second approval store"). Nothing here invents a second
// approval queue — a proposed `ShareCandidate` is enqueued onto the same
// `ApprovalQueuePort` the sensitivity-egress path already uses, and the operator
// approving it mints the `ApprovedShareCapsule` server-side, inside the queue's
// terminal execute callback. Only the capsule CUSTODY (the minted capsule, its
// monotonic use-count, and its revocation state) is new durable state.
//
// Custody obligations satisfied here (jp36.7.1.1 review gate):
//
//   1. Integrity-at-rest. The capsule's unsigned fields (permittedDestinations,
//      expiry, revoked) are protected only by THIS store's integrity-at-rest, so
//      custody stays server-side, outside companion reach, and is NEVER round-
//      tripped through a model-influenced surface. The on-disk record is re-
//      parsed with `parseApprovedShareCapsule` on every load: a capsule tampered
//      at rest (content edited, hash left stale, authority flipped) fails the
//      self-authenticating parse and the whole load fails closed.
//   2. Durable, monotonic use-count. The use-count lives ONLY here and is only
//      ever incremented. EVERY mutating operation (mint, use, revoke) runs the
//      whole read → validate → apply → persist cycle inside a cross-process
//      write lock (`withCrossProcessWriteLock`, the same mkdir-based mutual
//      exclusion the session-journal path uses), and RE-READS the file under the
//      lock before deciding. A compare-and-set on the expected prior count then
//      turns any use that raced ahead into an explicit fail-closed conflict —
//      never a silent lost update, and never two processes both committing N+1
//      over the same N (the pre-lock last-writer-wins hazard). `authorizeReplay`
//      injects `priorUseCount` from this persisted state — never a caller-
//      supplied zero.
//   3. Self-authenticating authorization. Replay authorization goes through
//      `authorizeCapsuleUse` (which parses + self-authenticates the capsule),
//      never raw `evaluateCapsuleUse` on an unparsed object.
//
// Storage model mirrors the sibling cogsec custody store (`quarantine-store.ts`,
// htm9.11): one JSON file under companion-data/state, fail-closed validation on
// load, and a reload on every operation because the gateway process, the agent
// process, and the Garden surface each construct their own instance over the
// same file. Because those are genuinely separate OS processes, an in-memory
// reload is NOT enough on its own: every write is serialized by a cross-process
// lock (see the durable-use-count obligation above) and published with a
// per-process-unique tmp name + atomic rename, so concurrent writers can never
// clobber one another's increment nor publish a half-written file. Reads stay
// lock-free: `renameSync` is atomic, so a reader observes either the whole old
// file or the whole new one, and a torn parse fails closed. See
// `resolveShareCapsuleCustodyPath`.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { withCrossProcessWriteLock } from '../../../persistence/sessions/cross-process-write-lock.js';
import { sensitivityOrd, type SensitivityLevel } from '../../../system/trust/types.js';
import type {
  ApprovalQueuePort,
  ConfirmationExecutionContext,
  ConfirmationQueueEntry,
} from '../../../system/capabilities/approval-queue-port.js';
import {
  approveShareCandidate,
  authorizeCapsuleUse,
  parseApprovedShareCapsule,
  revokeShareCapsule,
  type ApprovedShareCapsule,
  type CapsuleDenyCode,
  type CapsuleExpiry,
  type ShareApprovalGrant,
  type ShareCandidate,
  type ShareContent,
} from './capsule.js';
import type { DisclosureDestination } from './contracts.js';

/** Schema version for the on-disk custody file. */
export const SHARE_CAPSULE_CUSTODY_FILE_VERSION = 1 as const;

/**
 * Default cap on simultaneously-active capsules (bible §10.11: "An initial cap
 * of three active capsules is a reasonable queue bound"). Custody enforces the
 * cap at mint so the concern system never becomes a content queue. Configurable
 * via {@link ShareCapsuleCustodyStoreOptions.maxActiveCapsules}.
 */
export const DEFAULT_MAX_ACTIVE_CAPSULES = 3;

/** The approval-queue method/action the publication share lane rides. */
export const SHARE_CAPSULE_APPROVAL_METHOD = 'share.capsule' as const;
export const SHARE_CAPSULE_APPROVAL_ACTION = 'share' as const;

/**
 * Cross-process write-lock tuning for custody mutations. `staleMs` is well above
 * the heartbeat's minimum tokenized threshold so a briefly-held lock is never
 * mistaken for abandoned; `timeoutMs` bounds acquisition so a wedged holder
 * surfaces loudly instead of hanging a share. Mutations here are short (read a
 * small JSON file, validate, rewrite it), so the poll interval stays tight.
 */
const CUSTODY_LOCK_OPTIONS = {
  pollMs: 10,
  staleMs: 30_000,
  timeoutMs: 10_000,
} as const;

// ── Persisted record ────────────────────────────────────────────────────────

/**
 * One capsule's durable custody record. `capsuleId` is duplicated out of the
 * capsule so the file is keyed and de-dup-checkable without parsing every
 * capsule twice; on load the two MUST agree (fail closed otherwise).
 */
export interface ShareCapsuleCustodyRecord {
  readonly capsuleId: string;
  readonly capsule: ApprovedShareCapsule;
  /** Monotonic count of exact-replay uses already consumed. Never decreases. */
  readonly useCount: number;
  readonly mintedAtMs: number;
}

interface CustodyFileShape {
  version: typeof SHARE_CAPSULE_CUSTODY_FILE_VERSION;
  entries: ShareCapsuleCustodyRecord[];
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface ShareCapsuleCustodyState {
  readonly capsule: ApprovedShareCapsule;
  readonly useCount: number;
}

export interface RecordReplayUseInput {
  readonly capsuleId: string;
  /**
   * The use-count the caller authorized against. The store fails closed unless
   * the persisted count still equals this — a compare-and-set that turns a
   * concurrent increment into an explicit conflict rather than a lost update.
   */
  readonly expectedPriorUseCount: number;
  readonly atMs?: number;
}

export interface RevokeCapsuleInput {
  readonly capsuleId: string;
  readonly revokedAt: string;
  readonly reason?: string;
}

export interface ShareCapsuleCustodyStore {
  /**
   * Persist a freshly-minted capsule under its id. Throws on a duplicate id, an
   * unparseable capsule, or when the active-capsule cap is already reached.
   */
  putApprovedCapsule(capsule: ApprovedShareCapsule, atMs?: number): ShareCapsuleCustodyRecord;
  /** Parsed capsule + persisted use-count, or undefined when absent. */
  getCapsuleState(capsuleId: string): ShareCapsuleCustodyState | undefined;
  /**
   * Atomically increment the monotonic use-count. Fails closed on an unknown id,
   * a revoked capsule, an exhausted use-count, or an expected-prior mismatch.
   */
  recordExactReplayUse(input: RecordReplayUseInput): ShareCapsuleCustodyState;
  /** Flip revocation (terminal, wins over every other state). Idempotent. */
  revokeCapsule(input: RevokeCapsuleInput): ApprovedShareCapsule;
  /** All custody records, most-recently-minted first. */
  list(): ShareCapsuleCustodyRecord[];
}

export interface ShareCapsuleCustodyStoreOptions {
  /** Active-capsule cap (bible §10.11). Defaults to {@link DEFAULT_MAX_ACTIVE_CAPSULES}. */
  maxActiveCapsules?: number;
  now?: () => number;
}

function invalidRecord(filePath: string, detail: string): Error {
  return new Error(`Invalid share capsule custody record in ${filePath}: ${detail}`);
}

function assertRecordShape(value: unknown, filePath: string): ShareCapsuleCustodyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRecord(filePath, 'record must be an object');
  }
  const record = value as Record<string, unknown>;
  const knownKeys = ['capsuleId', 'capsule', 'useCount', 'mintedAtMs'];
  const unknownKeys = Object.keys(record).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidRecord(filePath, `unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (typeof record.capsuleId !== 'string' || !record.capsuleId.trim()) {
    throw invalidRecord(filePath, 'missing capsuleId');
  }
  // Self-authenticating parse: a capsule edited at rest (content changed, hash
  // left stale, authority flipped, expiry unbounded) fails here — fail closed.
  const capsule = parseApprovedShareCapsule(record.capsule);
  if (!capsule) {
    throw invalidRecord(filePath, `capsule '${record.capsuleId}' failed the ApprovedShareCapsule contract (tampered at rest?)`);
  }
  if (capsule.capsuleId !== record.capsuleId) {
    throw invalidRecord(filePath, `record capsuleId '${record.capsuleId}' does not match capsule.capsuleId '${capsule.capsuleId}'`);
  }
  if (typeof record.useCount !== 'number' || !Number.isInteger(record.useCount) || record.useCount < 0) {
    throw invalidRecord(filePath, `useCount for '${record.capsuleId}' must be a non-negative integer`);
  }
  // A persisted count above the capsule's own cap is corrupt state, not a
  // recoverable condition — the cap is part of the approved authority.
  if (capsule.expiry.maxUseCount !== undefined && record.useCount > capsule.expiry.maxUseCount) {
    throw invalidRecord(filePath, `useCount ${record.useCount} for '${record.capsuleId}' exceeds its cap of ${capsule.expiry.maxUseCount}`);
  }
  if (typeof record.mintedAtMs !== 'number' || !Number.isFinite(record.mintedAtMs)) {
    throw invalidRecord(filePath, `mintedAtMs for '${record.capsuleId}' must be a finite number`);
  }
  return { capsuleId: record.capsuleId, capsule, useCount: record.useCount, mintedAtMs: record.mintedAtMs };
}

/** A capsule is "active" while it can still authorize a use (cap accounting). */
function capsuleIsActive(record: ShareCapsuleCustodyRecord, atMs: number): boolean {
  const { capsule } = record;
  if (capsule.revocation.revoked) return false;
  if (capsule.expiry.expiresAt !== undefined && atMs >= Date.parse(capsule.expiry.expiresAt)) return false;
  if (capsule.expiry.maxUseCount !== undefined && record.useCount >= capsule.expiry.maxUseCount) return false;
  return true;
}

export function createShareCapsuleCustodyStore(
  filePath: string,
  options: ShareCapsuleCustodyStoreOptions = {},
): ShareCapsuleCustodyStore {
  const maxActiveCapsules = options.maxActiveCapsules ?? DEFAULT_MAX_ACTIVE_CAPSULES;
  if (!Number.isInteger(maxActiveCapsules) || maxActiveCapsules <= 0) {
    throw new Error('Share capsule custody store requires a positive integer maxActiveCapsules');
  }
  const now = options.now ?? Date.now;
  // Cross-process mutual exclusion for every write. mkdir-based, atomic on
  // POSIX, with stale-lock recovery — the same mechanism the session-journal
  // path uses to serialize agent/gateway/garden against a shared file.
  const lockPath = `${filePath}.lock`;

  // Always reload from disk: gateway, agent, and Garden each hold their own
  // instance over the same file, so a cached map would go stale.
  const load = (): Map<string, ShareCapsuleCustodyRecord> => {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== SHARE_CAPSULE_CUSTODY_FILE_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error(`Unsupported share capsule custody file shape at ${filePath}`);
    }
    const entries = new Map<string, ShareCapsuleCustodyRecord>();
    for (const value of parsed.entries) {
      const record = assertRecordShape(value, filePath);
      if (entries.has(record.capsuleId)) {
        throw invalidRecord(filePath, `duplicate capsuleId '${record.capsuleId}'`);
      }
      entries.set(record.capsuleId, record);
    }
    return entries;
  };

  // Sweep sibling `*.tmp` publish files. Only ever called while THIS process
  // holds the exclusive write lock, so no other writer can own a live tmp: any
  // `${basename}.*.tmp` present is an orphan left by a crashed writer and is
  // safe to remove. Never touches the lock dir or its reclaim tombstones (they
  // do not end in `.tmp`).
  const sweepOrphanTmp = (dir: string): void => {
    const prefix = `${basename(filePath)}.`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) {
        rmSync(join(dir, name), { force: true });
      }
    }
  };

  // Publish atomically through a PER-PROCESS-UNIQUE tmp name. A fixed shared
  // `${filePath}.tmp` let two concurrent writers publish each other's half-
  // written tmp (torn read → uncaught SyntaxError on load). A unique name +
  // renameSync means each writer only ever renames its own fully-written file.
  const persist = (entries: Map<string, ShareCapsuleCustodyRecord>): void => {
    const payload: CustodyFileShape = { version: SHARE_CAPSULE_CUSTODY_FILE_VERSION, entries: [...entries.values()] };
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    sweepOrphanTmp(dir);
    const tmpPath = join(dir, `${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  };

  // Every mutation runs its whole read → validate → apply → persist cycle inside
  // the cross-process lock, re-reading the file under the lock. This is what
  // makes the compare-and-set and the revocation check sound across processes:
  // a sibling can neither slip an increment in between our read and our write,
  // nor resurrect a capsule we just revoked.
  const withWriteLock = <T>(mutate: () => T): T =>
    withCrossProcessWriteLock(lockPath, CUSTODY_LOCK_OPTIONS, () => mutate());

  return {
    putApprovedCapsule(capsule: ApprovedShareCapsule, atMs?: number): ShareCapsuleCustodyRecord {
      // Re-parse before persisting: never write a capsule that would not survive
      // its own load-time self-authentication.
      const validated = parseApprovedShareCapsule(capsule);
      if (!validated) {
        throw new Error('Cannot persist a capsule that fails the ApprovedShareCapsule contract');
      }
      const mintedAtMs = atMs ?? now();
      return withWriteLock(() => {
        const entries = load();
        if (entries.has(validated.capsuleId)) {
          throw new Error(`Share capsule custody already holds capsule '${validated.capsuleId}'`);
        }
        const activeCount = [...entries.values()].filter((record) => capsuleIsActive(record, mintedAtMs)).length;
        if (activeCount >= maxActiveCapsules) {
          throw new Error(
            `Active share-capsule cap reached (${activeCount}/${maxActiveCapsules}); revoke or let a capsule expire before minting another`,
          );
        }
        const record: ShareCapsuleCustodyRecord = {
          capsuleId: validated.capsuleId,
          capsule: validated,
          useCount: 0,
          mintedAtMs,
        };
        entries.set(record.capsuleId, record);
        persist(entries);
        return record;
      });
    },

    getCapsuleState(capsuleId: string): ShareCapsuleCustodyState | undefined {
      const record = load().get(capsuleId);
      if (!record) return undefined;
      return { capsule: record.capsule, useCount: record.useCount };
    },

    recordExactReplayUse(input: RecordReplayUseInput): ShareCapsuleCustodyState {
      return withWriteLock(() => {
        // Re-read UNDER the lock: the state the caller compare-and-set against
        // may already have advanced in another process since it was observed.
        const entries = load();
        const record = entries.get(input.capsuleId);
        if (!record) {
          throw new Error(`Share capsule custody has no capsule '${input.capsuleId}'`);
        }
        // Revocation is terminal and wins over any authorized-looking replay.
        // Re-checked here under the lock so a revoke committed by a sibling
        // between the caller's read and this write can never be out-raced.
        if (record.capsule.revocation.revoked) {
          throw new Error(`Capsule '${input.capsuleId}' is revoked; no further use may be recorded`);
        }
        // Compare-and-set: a concurrent writer that already advanced the count
        // makes this an explicit conflict, never a silent lost update. Under the
        // lock the losing writer sees the winner's committed count and fails.
        if (record.useCount !== input.expectedPriorUseCount) {
          throw new Error(
            `Capsule '${input.capsuleId}' use-count moved to ${record.useCount}, expected ${input.expectedPriorUseCount} (concurrent use)`,
          );
        }
        const cap = record.capsule.expiry.maxUseCount;
        if (cap !== undefined && record.useCount >= cap) {
          throw new Error(`Capsule '${input.capsuleId}' use-count ${record.useCount} already reached its cap of ${cap}`);
        }
        const nextUseCount = record.useCount + 1;
        entries.set(record.capsuleId, { ...record, useCount: nextUseCount });
        persist(entries);
        return { capsule: record.capsule, useCount: nextUseCount };
      });
    },

    revokeCapsule(input: RevokeCapsuleInput): ApprovedShareCapsule {
      return withWriteLock(() => {
        // Re-read under the lock so a use committed by a sibling since the caller
        // last observed the capsule is folded in before we rewrite the record —
        // a revoke never silently drops a concurrent increment.
        const entries = load();
        const record = entries.get(input.capsuleId);
        if (!record) {
          throw new Error(`Share capsule custody has no capsule '${input.capsuleId}'`);
        }
        // Idempotent: revoking an already-revoked capsule keeps it revoked.
        const revoked = record.capsule.revocation.revoked
          ? record.capsule
          : revokeShareCapsule(record.capsule, {
            revokedAt: input.revokedAt,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          });
        entries.set(record.capsuleId, { ...record, capsule: revoked });
        persist(entries);
        return revoked;
      });
    },

    list(): ShareCapsuleCustodyRecord[] {
      return [...load().values()].sort((left, right) => right.mintedAtMs - left.mintedAtMs);
    },
  };
}

// ── Custody service (rides the existing ApprovalQueuePort) ──────────────────────

/**
 * Reasons a replay is denied at the custody seam. Extends the pure capsule deny
 * codes with the two the durable seam adds:
 *   - `capsule_not_found`  — no custody record for the id.
 *   - `source_reclassified` — the live effective sensitivity of the capsule's
 *      provenance is now MORE restrictive than the sensitivity the capsule was
 *      approved at, so the exact-replay approval no longer covers it (bible §6.3
 *      most-restrictive rule; §10.10 "changing … invalidates the approval").
 */
export type CapsuleCustodyDenyCode = CapsuleDenyCode | 'capsule_not_found' | 'source_reclassified';

export type CapsuleReplayDecision =
  | { readonly authorized: true; readonly reason: string; readonly useCount: number }
  | { readonly authorized: false; readonly code: CapsuleCustodyDenyCode; readonly reason: string };

export interface ProposeShareCandidateInput {
  readonly candidate: ShareCandidate;
  /** Bounded authority window the approval grants (bible §10.11). */
  readonly proposedExpiry: CapsuleExpiry;
  readonly companionReason: string;
  /** Human-readable scope for the approval entry (destination summary). */
  readonly approvalScope: string;
}

export interface AuthorizeReplayInput {
  readonly capsuleId: string;
  readonly content: ShareContent;
  readonly destination: DisclosureDestination;
  readonly now: string;
  /**
   * The freshly-resolved effective sensitivity of the capsule's provenance at
   * replay time (the caller resolves it from live classification, exactly as the
   * sensitivity-egress path re-reads current classifications before an approved
   * share). Required — replay never trusts the sensitivity frozen at approval.
   */
  readonly currentEffectiveSensitivity: SensitivityLevel;
}

export interface CapsuleCustodyService {
  /**
   * Enqueue a proposed share onto the existing approval queue. The operator's
   * approval runs the terminal callback that mints the capsule server-side and
   * persists it — there is no separate approval store. Rejects an operator
   * attempt to edit the proposed content (the human raises concerns; the
   * companion re-submits — bible §10.10 edit-loop).
   */
  proposeShareCandidate(input: ProposeShareCandidateInput): ConfirmationQueueEntry;
  /**
   * Authorize (and, on success, durably consume) one exact-replay use. Loads the
   * persisted capsule + monotonic use-count, denies fail-closed on
   * reclassification, then defers to `authorizeCapsuleUse`; a granted use is
   * recorded before returning so the count advances exactly once.
   */
  authorizeReplay(input: AuthorizeReplayInput): CapsuleReplayDecision;
  revokeCapsule(input: RevokeCapsuleInput): ApprovedShareCapsule;
}

export interface CapsuleCustodyServiceOptions {
  readonly store: ShareCapsuleCustodyStore;
  readonly approvalQueue: ApprovalQueuePort;
  /** Wall clock for mint/use timestamps. Defaults to Date.now. */
  readonly now?: () => number;
  /** Capsule-id factory (server-side; never caller/model supplied). */
  readonly capsuleIdFactory?: () => string;
}

/** Canonical, model-free projection of a candidate for the approval entry params. */
function candidateApprovalParams(candidate: ShareCandidate): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    contentHash: candidate.contentHash,
    proposedDestinations: candidate.proposedDestinations,
    effectiveSensitivity: candidate.effectiveSensitivity,
    provenanceRefs: candidate.provenanceRefs,
    subjectContactIds: candidate.subjectContactIds,
  };
}

export function createCapsuleCustodyService(options: CapsuleCustodyServiceOptions): CapsuleCustodyService {
  const now = options.now ?? Date.now;
  const capsuleIdFactory = options.capsuleIdFactory ?? (() => `capsule-${randomUUID()}`);
  const { store, approvalQueue } = options;

  return {
    proposeShareCandidate(input: ProposeShareCandidateInput): ConfirmationQueueEntry {
      const candidate = input.candidate;
      const queueParams = candidateApprovalParams(candidate);
      const serializedParams = JSON.stringify(queueParams);
      return approvalQueue.enqueue({
        method: SHARE_CAPSULE_APPROVAL_METHOD,
        action: SHARE_CAPSULE_APPROVAL_ACTION,
        scope: input.approvalScope,
        params: queueParams,
        companionReason: input.companionReason,
        resolutionAuthority: 'operator',
      }, async (approvedParams: Record<string, unknown>, _entry: ConfirmationQueueEntry, context: ConfirmationExecutionContext) => {
        // The human reviews with provenance and raises concerns; they do NOT edit
        // the companion's prose (bible §10.10). Any parameter change is refused —
        // approval binds to the EXACT proposed content only.
        if (JSON.stringify(approvedParams) !== serializedParams) {
          throw new Error('Share capsule approval parameters cannot be modified; the companion must re-submit edited content');
        }
        const approvedAtMs = now();
        const actor = context.resolver?.kind === 'operator' && context.resolver.id.trim()
          ? `operator:${context.resolver.id.trim()}`
          : 'operator';
        const grant: ShareApprovalGrant = {
          capsuleId: capsuleIdFactory(),
          actor,
          approvedAt: new Date(approvedAtMs).toISOString(),
          expiry: input.proposedExpiry,
        };
        // Mint server-side from the persisted candidate; approveShareCandidate
        // recomputes the content hash and never trusts an inbound one.
        const capsule = approveShareCandidate(candidate, grant);
        store.putApprovedCapsule(capsule, approvedAtMs);
        return { capsuleId: capsule.capsuleId };
      });
    },

    authorizeReplay(input: AuthorizeReplayInput): CapsuleReplayDecision {
      const state = store.getCapsuleState(input.capsuleId);
      if (!state) {
        return { authorized: false, code: 'capsule_not_found', reason: `no capsule in custody for id '${input.capsuleId}'` };
      }
      // Reclassification gate: if the live provenance is now more restrictive
      // than the approved sensitivity, the exact-replay approval no longer
      // covers it — deny before touching the use-count.
      if (sensitivityOrd(input.currentEffectiveSensitivity) > sensitivityOrd(state.capsule.effectiveSensitivity)) {
        return {
          authorized: false,
          code: 'source_reclassified',
          reason: `capsule provenance reclassified to '${input.currentEffectiveSensitivity}', above the approved '${state.capsule.effectiveSensitivity}'; replay requires fresh approval`,
        };
      }
      // Self-authenticating authorization with the PERSISTED prior use-count —
      // never a caller-supplied zero.
      const decision = authorizeCapsuleUse(state.capsule, {
        intent: 'exact_replay',
        content: input.content,
        destination: input.destination,
        now: input.now,
        priorUseCount: state.useCount,
      });
      if (!decision.authorized) {
        return { authorized: false, code: decision.code, reason: decision.reason };
      }
      // Durably consume exactly one use. A concurrent writer that already
      // advanced the count turns this into a fail-closed conflict.
      let consumed: ShareCapsuleCustodyState;
      try {
        consumed = store.recordExactReplayUse({
          capsuleId: input.capsuleId,
          expectedPriorUseCount: state.useCount,
          atMs: now(),
        });
      } catch (error) {
        return {
          authorized: false,
          code: 'use_count_exhausted',
          reason: `could not record capsule use: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { authorized: true, reason: decision.reason, useCount: consumed.useCount };
    },

    revokeCapsule(input: RevokeCapsuleInput): ApprovedShareCapsule {
      return store.revokeCapsule(input);
    },
  };
}
