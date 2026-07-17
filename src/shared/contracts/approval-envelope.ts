/**
 * Unified human-in-the-loop approval envelope (bead psfn-framework-ct0v).
 *
 * PSFN has several subsystems that need to route a "please decide, human"
 * request to the person's device: the gateway confirmation gate (tool /
 * information-access escalation and expensive-usage sign-off), shard capability
 * fold review, the Cognitive Security intake-quarantine queue, and broadcast
 * approvals. Historically each grew its own shape. This module standardizes ONE
 * envelope so every kind projects into the same relay path
 * (`companion.approval.requested` / `.resolved`) and renders through one
 * request-card contract on the app.
 *
 * The envelope is a REDACTED, allowlisted projection. It never carries raw tool
 * params, prompts, task text, chain-of-thought, filesystem paths, credentials,
 * or grant secrets. Attribution and grant offer are resolved SERVER-SIDE from
 * authenticated lineage — never trusted from client-supplied identity, scope,
 * or duration. See `docs/approval-envelope.md` for the full design, the kind
 * registry, the routing rule, and the projection roadmap.
 */

/**
 * Which subsystem raised the request. A tag for display/audit/routing hints —
 * NOT an authority claim. Open-ended union so a new subsystem can project into
 * the same envelope without a breaking contract change; the listed members are
 * the known projectors (present + planned).
 *
 * - `tool-access`      gateway confirmation gate: tool / information-access escalation
 * - `expensive-usage`  gateway confirmation gate: expensive-usage sign-off
 * - `shard`            shard capability fold review (planned; see SHARD_APPROVALS.md)
 * - `cogsec`           Cognitive Security intake-quarantine approvals (planned)
 */
export type ApprovalSourceSystem =
  | 'tool-access'
  | 'expensive-usage'
  | 'shard'
  | 'cogsec'
  // keep known-member autocomplete while leaving the union open to future projectors
  | (string & {});

/** Known, closed source-system tags — for validation / exhaustiveness helpers. */
export const KNOWN_APPROVAL_SOURCE_SYSTEMS = [
  'tool-access',
  'expensive-usage',
  'shard',
  'cogsec',
] as const satisfies readonly ApprovalSourceSystem[];

/**
 * Server-resolved attribution for a request. All identifiers are OPAQUE routing
 * keys resolved from authenticated lineage at enqueue; labels are presentation
 * only. `parentId` is always the owning parent companion's canonical id (the
 * routing/ownership key). `shardId`/`shardLabel` are additional provenance,
 * present only when a shard raised the request — never an owner, never a
 * peer-companion identity.
 */
export interface ApprovalAttribution {
  parentLabel: string;
  parentId: string;
  shardLabel?: string;
  shardId?: string;
}

/**
 * The exact grant the server is OFFERING for this request.
 *
 * - `once` request-scoped: the default; authorizes the exact queued operation
 *   one time. This is the only mode the server may emit today.
 * - `ttl`  time-limited: CONTRACT-ONLY. The union carries it so the app and
 *   wire agree on the shape, but the server MUST NOT emit `ttl` until the
 *   separately-approved JSON-owned TTL policy exists (eligible actions, maximum
 *   TTL, revocation, recovery). See `companion-ui/SHARD_APPROVALS.md` §Temporary
 *   Grant Semantics and `docs/shard-capability-tier-derivation.md`.
 */
export type ApprovalGrantMode =
  | { kind: 'once' }
  | { kind: 'ttl'; ttlSeconds: number };

/** Terminal states an approval can settle into (mirrors the resolved payload). */
export const APPROVAL_TERMINAL_STATUSES = [
  'approved',
  'denied',
  'expired',
  'blocked',
] as const;

export type ApprovalTerminalStatus = typeof APPROVAL_TERMINAL_STATUSES[number];

/**
 * The unified v2 request envelope superset. Every approval kind projects into
 * these allowlisted fields. `CompanionApprovalRequestedPayload` in
 * `companion-relay.ts` is the wire realization of this contract (v1 fields plus
 * these optional v2 fields, additive so old clients keep parsing).
 */
export interface ApprovalRequestEnvelope {
  /** Approval / request id — the queue key; possession is never authority. */
  id: string;
  /** Which subsystem raised it (tag only). */
  sourceSystem: ApprovalSourceSystem;
  /** Server-resolved lineage. */
  attribution: ApprovalAttribution;
  /** Redacted action verb. */
  action: string;
  /** Redacted normalized resource scope. */
  scope: string;
  /** Redacted, companion-authored reason. */
  reason: string;
  /** The grant the server is offering (always `once` until TTL policy ships). */
  grantMode: ApprovalGrantMode;
  /** ISO timestamp the request was created. */
  requestedAt: string;
  /** ISO timestamp the request expires, when bounded. */
  expiresAt?: string;
  status: 'pending';
}

/** True when a grant offer is the request-scoped default. */
export function isRequestScopedGrant(mode: ApprovalGrantMode): mode is { kind: 'once' } {
  return mode.kind === 'once';
}
