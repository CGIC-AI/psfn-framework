// ── CogSec publication review: Share Capsule contracts (bible §10.10–10.11) ──
//
// The publication review/edit lifecycle lives in CogSec and rides the existing
// gateway egress/approval architecture — there is NO second approval store
// (bible §10.10 "Settled", adjudication R1/R8). This module owns only the pure
// CONTRACT shapes and fail-closed decision helpers for the two publication
// review objects and the authority they carry. Runtime wiring onto the gateway
// sensitivity-egress approval path is a sibling bead (jp36.7.1.2); the Garden
// provenance surface (jp36.7.2) and the companion edit-loop tool (jp36.7.3) are
// siblings too. Nothing here reads a clock, a store, or config — the current
// time and prior use-count are injected by the caller.
//
// Five load-bearing properties are encoded and tested here:
//
//   1. Content-hash binding — an ApprovedShareCapsule is bound to the EXACT
//      approved content via an immutable sha256 hash. Any edit (a character in
//      the body, a reordered/changed media ref) yields a different hash and
//      the capsule no longer authorizes that content. The stored capsule is
//      self-authenticating: its `contentHash` must equal the hash of its own
//      `content`, so a tampered capsule fails closed at parse.
//   2. Expiry — a capsule carries an expiration timestamp and/or a maximum use
//      count. A capsule with neither bound is rejected: authority is never
//      unbounded in time and volume.
//   3. Revocation — revocation is the strongest kill switch. A revoked capsule
//      denies every use regardless of expiry, hash, or destination.
//   4. Replay-vs-generative authority — a capsule carries EXACT-REPLAY
//      authority, not generative-input authority (bible §10.11 "Settled").
//      Approving exact content for a destination does not declassify its
//      provenance: reusing it as a generative input to a new work ALWAYS
//      requires fresh approval. This is encoded in the intrinsic capsule
//      `authority` literal and enforced categorically in the use check.
//   5. Fail-closed — absent, garbled, expired, revoked, hash-mismatched, or
//      out-of-destination capsules deny the use with an explicit reason code;
//      no swallowed errors, no silent fallback.

import { createHash } from 'node:crypto';

import type { SensitivityLevel } from '../../../system/trust/types.js';
import { isSensitivityLevel } from '../../../shared/contracts/artifact-sensitivity.js';
import { isBoundedString, isRecord } from '../../../shared/utils/types.js';
import {
  DISCLOSURE_KIND_ID_FIELD,
  isDisclosureDestinationKind,
  type DisclosureDestination,
  type DisclosureDestinationConstraint,
} from './contracts.js';
import { destinationPermitted } from './decision.js';

// ── Versioning ───────────────────────────────────────────────────────────────

/** Schema version for ShareCandidate / ApprovedShareCapsule records. */
export const SHARE_CAPSULE_SCHEMA_VERSION = 1 as const;

/**
 * Version tag folded into the canonical content serialization before hashing.
 * Bump only if the canonicalization of `ShareContent` changes; a bump changes
 * every hash and therefore invalidates every prior capsule by construction.
 */
export const SHARE_CONTENT_HASH_VERSION = 1 as const;

/**
 * A capsule carries exact-replay authority ONLY (bible §10.11). This is an
 * intrinsic, single-valued literal rather than a mode toggle: there is no
 * "generative" capsule. Generative reuse of restricted-provenance content
 * always requires a fresh approval. The literal is validated on parse so a
 * capsule asserting any other authority fails closed.
 */
export const CAPSULE_AUTHORITY = 'exact_replay' as const;
export type CapsuleAuthority = typeof CAPSULE_AUTHORITY;

// ── Content + hash binding ─────────────────────────────────────────────────────

/**
 * The exact payload an approval binds to. `body` is verbatim (never trimmed —
 * whitespace is content); `mediaRefs` is order-significant (reordering embedded
 * media is an edit that invalidates the approval, bible §10.10).
 */
export interface ShareContent {
  readonly body: string;
  readonly mediaRefs: readonly string[];
}

/**
 * Immutable content fingerprint: sha256 over a versioned canonical JSON of the
 * exact payload. Any mutation of `body` or `mediaRefs` (including reordering)
 * produces a different hash. Mirrors the repo's sha256-over-versioned-JSON
 * digest convention (see `privacy-break-glass.ts`, `artifact-sensitivity.ts`).
 */
export function hashShareContent(content: ShareContent): string {
  const canonical = {
    v: SHARE_CONTENT_HASH_VERSION,
    body: content.body,
    mediaRefs: [...content.mediaRefs],
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Fail-closed parse of an untrusted content record. */
export function parseShareContent(value: unknown): ShareContent | null {
  if (!isRecord(value)) return null;
  if (typeof value.body !== 'string') return null;
  const rawMedia = value.mediaRefs;
  if (rawMedia === undefined) return { body: value.body, mediaRefs: [] };
  if (!Array.isArray(rawMedia)) return null;
  const mediaRefs: string[] = [];
  for (const ref of rawMedia) {
    if (typeof ref !== 'string') return null;
    const trimmed = ref.trim();
    if (!trimmed) return null;
    mediaRefs.push(trimmed);
  }
  return { body: value.body, mediaRefs };
}

function normalizeShareContent(content: { readonly body: string; readonly mediaRefs?: readonly string[] }): ShareContent {
  const mediaRefs: string[] = [];
  for (const ref of content.mediaRefs ?? []) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    mediaRefs.push(trimmed);
  }
  return { body: content.body, mediaRefs };
}

// ── Expiry ─────────────────────────────────────────────────────────────────────

/**
 * Bounded authority window. At least one of the two bounds MUST be present —
 * a capsule with neither is rejected on parse so authority can never be
 * unbounded in both time and volume.
 */
export interface CapsuleExpiry {
  /** ISO timestamp; the capsule is expired once current time reaches it. */
  readonly expiresAt?: string;
  /** Maximum number of exact-replay uses; positive integer when present. */
  readonly maxUseCount?: number;
}

export function parseCapsuleExpiry(value: unknown): CapsuleExpiry | null {
  if (!isRecord(value)) return null;
  const result: { expiresAt?: string; maxUseCount?: number } = {};
  if (value.expiresAt !== undefined) {
    if (!isParseableTimestamp(value.expiresAt)) return null;
    result.expiresAt = value.expiresAt;
  }
  if (value.maxUseCount !== undefined) {
    if (typeof value.maxUseCount !== 'number' || !Number.isInteger(value.maxUseCount) || value.maxUseCount < 1) {
      return null;
    }
    result.maxUseCount = value.maxUseCount;
  }
  // Fail closed: authority must be bounded by time and/or use-count.
  if (result.expiresAt === undefined && result.maxUseCount === undefined) return null;
  return result;
}

// ── Revocation ───────────────────────────────────────────────────────────────

/** Revocation state. A revoked capsule denies every use (§10.11). */
export interface CapsuleRevocation {
  readonly revoked: boolean;
  /** When present (required when `revoked`), the ISO time of revocation. */
  readonly revokedAt?: string;
  readonly reason?: string;
}

export function parseCapsuleRevocation(value: unknown): CapsuleRevocation | null {
  if (!isRecord(value)) return null;
  if (typeof value.revoked !== 'boolean') return null;
  if (!value.revoked) {
    // A non-revoked record must not smuggle revocation metadata.
    if (value.revokedAt !== undefined || value.reason !== undefined) return null;
    return { revoked: false };
  }
  if (!isParseableTimestamp(value.revokedAt)) return null;
  const result: { revoked: true; revokedAt: string; reason?: string } = {
    revoked: true,
    revokedAt: value.revokedAt,
  };
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string') return null;
    const reason = value.reason.trim();
    if (reason) result.reason = reason;
  }
  return result;
}

// ── Approval attribution ───────────────────────────────────────────────────────

/** Who approved the exact content, and when. */
export interface ShareApproval {
  readonly actor: string;
  readonly approvedAt: string;
}

function parseShareApproval(value: unknown): ShareApproval | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.actor)) return null;
  if (!isParseableTimestamp(value.approvedAt)) return null;
  return { actor: value.actor, approvedAt: value.approvedAt };
}

// ── ShareCandidate (pre-approval proposal, bible §10.11) ────────────────────────

/**
 * A proposed-but-unapproved share. Created when the companion deliberately
 * chooses to propose sharing something outside its current trust scope
 * (§10.11); it is NOT a send. It carries the exact content, its content hash
 * (stable identity), the proposed destinations, and the provenance facts a
 * human needs to approve knowingly (surfaced by jp36.7.2). Approval turns it
 * into an ApprovedShareCapsule bound to this exact content.
 */
export interface ShareCandidate {
  readonly schemaVersion: typeof SHARE_CAPSULE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly content: ShareContent;
  readonly contentHash: string;
  readonly proposedDestinations: readonly DisclosureDestinationConstraint[];
  readonly effectiveSensitivity: SensitivityLevel;
  readonly provenanceRefs: readonly string[];
  readonly subjectContactIds: readonly string[];
  readonly createdAt: string;
}

export interface ShareCandidateDraft {
  readonly candidateId: string;
  readonly content: { readonly body: string; readonly mediaRefs?: readonly string[] };
  readonly proposedDestinations: readonly DisclosureDestinationConstraint[];
  readonly effectiveSensitivity: SensitivityLevel;
  readonly provenanceRefs?: readonly string[];
  readonly subjectContactIds?: readonly string[];
  readonly createdAt: string;
}

/**
 * Pure constructor for a ShareCandidate. Binds the content hash from the exact
 * content so the candidate's identity is fixed at creation. Throws on invalid
 * input rather than silently coercing.
 */
export function buildShareCandidate(draft: ShareCandidateDraft): ShareCandidate {
  const candidateId = draft.candidateId.trim();
  if (!candidateId) throw new Error('ShareCandidate requires a non-empty candidateId');
  if (!isParseableTimestamp(draft.createdAt)) throw new Error('ShareCandidate requires a valid createdAt timestamp');
  if (!isSensitivityLevel(draft.effectiveSensitivity)) {
    throw new Error('ShareCandidate requires a valid effectiveSensitivity');
  }
  const content = normalizeShareContent(draft.content);
  return {
    schemaVersion: SHARE_CAPSULE_SCHEMA_VERSION,
    candidateId,
    content,
    contentHash: hashShareContent(content),
    proposedDestinations: normalizeConstraintList(draft.proposedDestinations),
    effectiveSensitivity: draft.effectiveSensitivity,
    provenanceRefs: normalizeRefList(draft.provenanceRefs ?? []),
    subjectContactIds: normalizeRefList(draft.subjectContactIds ?? []),
    createdAt: draft.createdAt,
  };
}

export function parseShareCandidate(value: unknown): ShareCandidate | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SHARE_CAPSULE_SCHEMA_VERSION) return null;
  if (!isBoundedString(value.candidateId)) return null;
  const content = parseShareContent(value.content);
  if (!content) return null;
  if (typeof value.contentHash !== 'string' || value.contentHash !== hashShareContent(content)) return null;
  const proposedDestinations = parseConstraintList(value.proposedDestinations);
  if (!proposedDestinations) return null;
  if (!isSensitivityLevel(value.effectiveSensitivity)) return null;
  const provenanceRefs = parseRefList(value.provenanceRefs);
  if (!provenanceRefs) return null;
  const subjectContactIds = parseRefList(value.subjectContactIds);
  if (!subjectContactIds) return null;
  if (!isParseableTimestamp(value.createdAt)) return null;
  return {
    schemaVersion: SHARE_CAPSULE_SCHEMA_VERSION,
    candidateId: value.candidateId,
    content,
    contentHash: value.contentHash,
    proposedDestinations,
    effectiveSensitivity: value.effectiveSensitivity,
    provenanceRefs,
    subjectContactIds,
    createdAt: value.createdAt,
  };
}

// ── ApprovedShareCapsule (post-approval authority, bible §10.11) ────────────────

/**
 * A human-approved payload bound to exact content. Immutable except for its
 * revocation state (via `revokeShareCapsule`). Carries exact-replay authority
 * only; its `contentHash` binds it to `content`, and the parser rejects any
 * capsule whose stored hash does not match its own content.
 */
export interface ApprovedShareCapsule {
  readonly schemaVersion: typeof SHARE_CAPSULE_SCHEMA_VERSION;
  readonly capsuleId: string;
  readonly candidateId: string;
  readonly content: ShareContent;
  readonly contentHash: string;
  readonly permittedDestinations: readonly DisclosureDestinationConstraint[];
  readonly effectiveSensitivity: SensitivityLevel;
  readonly provenanceRefs: readonly string[];
  readonly subjectContactIds: readonly string[];
  readonly approval: ShareApproval;
  readonly expiry: CapsuleExpiry;
  readonly revocation: CapsuleRevocation;
  readonly authority: CapsuleAuthority;
}

export interface ShareApprovalGrant {
  readonly capsuleId: string;
  readonly actor: string;
  readonly approvedAt: string;
  readonly expiry: CapsuleExpiry;
}

/**
 * Pure: approve a candidate into a capsule. Binds `contentHash` by RECOMPUTING
 * it from the candidate's exact content (never trusting an inbound hash), and
 * copies the proposed destinations, sensitivity, and provenance forward. The
 * capsule starts un-revoked with exact-replay authority. Throws on invalid
 * grant input.
 */
export function approveShareCandidate(candidate: ShareCandidate, grant: ShareApprovalGrant): ApprovedShareCapsule {
  const capsuleId = grant.capsuleId.trim();
  if (!capsuleId) throw new Error('Share approval requires a non-empty capsuleId');
  const actor = grant.actor.trim();
  if (!actor) throw new Error('Share approval requires a non-empty actor');
  if (!isParseableTimestamp(grant.approvedAt)) throw new Error('Share approval requires a valid approvedAt timestamp');
  const expiry = parseCapsuleExpiry(grant.expiry);
  if (!expiry) throw new Error('Share approval requires a bounded expiry (expiresAt and/or maxUseCount)');
  return {
    schemaVersion: SHARE_CAPSULE_SCHEMA_VERSION,
    capsuleId,
    candidateId: candidate.candidateId,
    content: candidate.content,
    contentHash: hashShareContent(candidate.content),
    permittedDestinations: candidate.proposedDestinations,
    effectiveSensitivity: candidate.effectiveSensitivity,
    provenanceRefs: candidate.provenanceRefs,
    subjectContactIds: candidate.subjectContactIds,
    approval: { actor, approvedAt: grant.approvedAt },
    expiry,
    revocation: { revoked: false },
    authority: CAPSULE_AUTHORITY,
  };
}

/** Pure: return a revoked copy of the capsule. Revocation is terminal. */
export function revokeShareCapsule(
  capsule: ApprovedShareCapsule,
  input: { readonly revokedAt: string; readonly reason?: string },
): ApprovedShareCapsule {
  if (!isParseableTimestamp(input.revokedAt)) throw new Error('Capsule revocation requires a valid revokedAt timestamp');
  const reason = input.reason?.trim();
  return {
    ...capsule,
    revocation: reason
      ? { revoked: true, revokedAt: input.revokedAt, reason }
      : { revoked: true, revokedAt: input.revokedAt },
  };
}

export function parseApprovedShareCapsule(value: unknown): ApprovedShareCapsule | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SHARE_CAPSULE_SCHEMA_VERSION) return null;
  if (!isBoundedString(value.capsuleId)) return null;
  if (!isBoundedString(value.candidateId)) return null;
  const content = parseShareContent(value.content);
  if (!content) return null;
  // Self-authenticating: a stored capsule whose hash does not match its own
  // content has been tampered with — fail closed.
  if (typeof value.contentHash !== 'string' || value.contentHash !== hashShareContent(content)) return null;
  const permittedDestinations = parseConstraintList(value.permittedDestinations);
  if (!permittedDestinations) return null;
  if (!isSensitivityLevel(value.effectiveSensitivity)) return null;
  const provenanceRefs = parseRefList(value.provenanceRefs);
  if (!provenanceRefs) return null;
  const subjectContactIds = parseRefList(value.subjectContactIds);
  if (!subjectContactIds) return null;
  const approval = parseShareApproval(value.approval);
  if (!approval) return null;
  const expiry = parseCapsuleExpiry(value.expiry);
  if (!expiry) return null;
  const revocation = parseCapsuleRevocation(value.revocation);
  if (!revocation) return null;
  if (value.authority !== CAPSULE_AUTHORITY) return null;
  return {
    schemaVersion: SHARE_CAPSULE_SCHEMA_VERSION,
    capsuleId: value.capsuleId,
    candidateId: value.candidateId,
    content,
    contentHash: value.contentHash,
    permittedDestinations,
    effectiveSensitivity: value.effectiveSensitivity,
    provenanceRefs,
    subjectContactIds,
    approval,
    expiry,
    revocation,
    authority: CAPSULE_AUTHORITY,
  };
}

// ── Use authorization (the enforcement point) ──────────────────────────────────

/**
 * How a caller intends to use a capsule's content. `exact_replay` reproduces
 * the approved content verbatim to a permitted destination. `generative_input`
 * feeds restricted-provenance content into a NEW work — never authorized by a
 * capsule (bible §10.11); it always requires fresh approval.
 */
export const CAPSULE_USE_INTENTS = ['exact_replay', 'generative_input'] as const;
export type CapsuleUseIntent = typeof CAPSULE_USE_INTENTS[number];

export const CAPSULE_DENY_CODES = [
  'malformed_capsule',
  'invalid_use_request',
  'revoked',
  'generative_input_requires_fresh_approval',
  'expired',
  'use_count_exhausted',
  'content_hash_mismatch',
  'destination_not_permitted',
] as const;

export type CapsuleDenyCode = typeof CAPSULE_DENY_CODES[number];

/**
 * A concrete request to use a capsule. `content` is what the caller intends to
 * emit (checked against the capsule's bound hash — any edit mismatches).
 * `now` and `priorUseCount` are injected so the check stays pure.
 */
export interface CapsuleUseRequest {
  readonly intent: CapsuleUseIntent;
  readonly content: ShareContent;
  readonly destination: DisclosureDestination;
  readonly now: string;
  /** Uses already consumed (from the gateway store, sibling bead). */
  readonly priorUseCount: number;
}

export type CapsuleUseDecision =
  | { readonly authorized: true; readonly reason: string }
  | { readonly authorized: false; readonly code: CapsuleDenyCode; readonly reason: string };

function deny(code: CapsuleDenyCode, reason: string): CapsuleUseDecision {
  return { authorized: false, code, reason };
}

/**
 * Pure evaluation of a use request against an already-parsed capsule. Order is
 * deliberate and fail-closed:
 *
 *   request validity → revocation (wins) → generative-intent (categorical
 *   denial) → expiry → use-count → content-hash binding → destination.
 */
export function evaluateCapsuleUse(capsule: ApprovedShareCapsule, request: CapsuleUseRequest): CapsuleUseDecision {
  if (!(CAPSULE_USE_INTENTS as readonly string[]).includes(request.intent)) {
    return deny('invalid_use_request', 'unknown capsule use intent');
  }
  if (!Number.isInteger(request.priorUseCount) || request.priorUseCount < 0) {
    return deny('invalid_use_request', 'priorUseCount must be a non-negative integer');
  }
  if (!isParseableTimestamp(request.now)) {
    return deny('invalid_use_request', 'current time is not a parseable timestamp');
  }

  // Revocation is the strongest kill switch — it wins over every other state.
  if (capsule.revocation.revoked) {
    return deny('revoked', 'capsule has been revoked');
  }

  // A capsule authorizes replaying THAT content, never generative re-derivation.
  if (request.intent === 'generative_input') {
    return deny(
      'generative_input_requires_fresh_approval',
      'capsule carries exact-replay authority only; generative reuse of restricted provenance requires fresh approval (§10.11)',
    );
  }

  if (capsule.expiry.expiresAt !== undefined && Date.parse(request.now) >= Date.parse(capsule.expiry.expiresAt)) {
    return deny('expired', `capsule expired at ${capsule.expiry.expiresAt}`);
  }

  if (capsule.expiry.maxUseCount !== undefined && request.priorUseCount >= capsule.expiry.maxUseCount) {
    return deny('use_count_exhausted', `capsule use count ${request.priorUseCount} reached its cap of ${capsule.expiry.maxUseCount}`);
  }

  // Any edit to the content the caller intends to emit breaks the hash binding.
  if (hashShareContent(request.content) !== capsule.contentHash) {
    return deny('content_hash_mismatch', 'requested content does not match the approved content hash');
  }

  if (!destinationPermitted(capsule.permittedDestinations, request.destination)) {
    return deny('destination_not_permitted', 'destination is not in the capsule\'s permitted-destination set');
  }

  return { authorized: true, reason: 'exact-replay of approved content to a permitted destination' };
}

/**
 * Fail-closed entry point: parse an untrusted capsule record and evaluate the
 * use. An absent (`null`/`undefined`) or garbled capsule denies with
 * `malformed_capsule` — never throws, never silently proceeds.
 */
export function authorizeCapsuleUse(rawCapsule: unknown, request: CapsuleUseRequest): CapsuleUseDecision {
  const capsule = parseApprovedShareCapsule(rawCapsule);
  if (!capsule) return deny('malformed_capsule', 'capsule is absent or does not satisfy the ApprovedShareCapsule contract');
  return evaluateCapsuleUse(capsule, request);
}

// ── internal helpers ────────────────────────────────────────────────────────────

function isParseableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

/** Parse a JSON array of non-empty strings; `null` on any non-string/empty entry. */
function parseRefList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    refs.push(trimmed);
  }
  return refs;
}

function normalizeRefList(value: readonly string[]): string[] {
  const refs: string[] = [];
  for (const item of value) {
    const trimmed = item.trim();
    if (trimmed) refs.push(trimmed);
  }
  return refs;
}

function parseDisclosureDestinationConstraint(value: unknown): DisclosureDestinationConstraint | null {
  if (!isRecord(value)) return null;
  if (!isDisclosureDestinationKind(value.kind)) return null;
  const kind = value.kind;
  const field = DISCLOSURE_KIND_ID_FIELD[kind];
  const { channelIds, contactIds } = value;
  if (field === 'channelId') {
    if (contactIds !== undefined) return null;
    if (channelIds === undefined) return { kind };
    const ids = parseRefList(channelIds);
    if (!ids || ids.length === 0) return null;
    return { kind, channelIds: ids };
  }
  if (field === 'contactId') {
    if (channelIds !== undefined) return null;
    if (contactIds === undefined) return { kind };
    const ids = parseRefList(contactIds);
    if (!ids || ids.length === 0) return null;
    return { kind, contactIds: ids };
  }
  // Id-free kinds (companion_self, publication) must not carry id lists.
  if (channelIds !== undefined || contactIds !== undefined) return null;
  return { kind };
}

/** Parse a JSON array of destination constraints; `null` if any entry is invalid. */
function parseConstraintList(value: unknown): DisclosureDestinationConstraint[] | null {
  if (!Array.isArray(value)) return null;
  const constraints: DisclosureDestinationConstraint[] = [];
  for (const item of value) {
    const parsed = parseDisclosureDestinationConstraint(item);
    if (!parsed) return null;
    constraints.push(parsed);
  }
  return constraints;
}

function normalizeConstraintList(value: readonly DisclosureDestinationConstraint[]): DisclosureDestinationConstraint[] {
  const constraints: DisclosureDestinationConstraint[] = [];
  for (const item of value) {
    const parsed = parseDisclosureDestinationConstraint(item);
    if (!parsed) throw new Error(`Invalid disclosure destination constraint: ${JSON.stringify(item)}`);
    constraints.push(parsed);
  }
  return constraints;
}
