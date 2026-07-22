// ── Shard capability derivation (mus2.1) ──
// One pure capability-system primitive shared by the shard manager and the
// gateway: snapshot the authoritative parent grant once, validate and
// canonicalize its tokens, subtract the approved shard denial mask, and return
// an immutable `custom` shard access plus a content-stable owner version and
// grant digest for cross-boundary equality checks.
//
// Design authority: docs/shard-capability-tier-derivation.md (psfn-framework-yijy.1).
// Non-goals here: no ShardManager or gateway wiring, no owner-file schema
// change, no new tier, no fallback to tier-name defaults for custom parents.

import { createHash } from 'node:crypto';
import type { CapabilityAccess, CapabilityGrantSnapshot } from './access.js';
import type { CapabilityTier } from './tier-types.js';
import { CAPABILITY_TIER_DEFAULTS, isCapabilityTier } from './tiers.js';
import { CAPABILITY_TOKENS, isCapabilityToken, type CapabilityToken } from './tokens.js';

/**
 * Shard-grant derivation contract version. Any change to the denial mask, the
 * canonicalization rules, or the digest payload shape MUST bump this value so
 * a manager and gateway running different contracts can never agree on a
 * digest by accident.
 */
export const SHARD_GRANT_DERIVATION_VERSION = 'psfn.shard-grant.v2';

/**
 * Owner-version contract label. The owner version is a SHA-256 digest of the
 * canonical validated owner content (tier + canonical customTokens). It is
 * content-stable across processes and never derived from file mtimes or
 * process-local cache state.
 */
export const CAPABILITY_OWNER_VERSION_CONTRACT = 'psfn.capability-owner.v1';

const CAPABILITY_TOKEN_ORDER: ReadonlyMap<CapabilityToken, number> = new Map(
  CAPABILITY_TOKENS.map((token, index) => [token, index]),
);

/**
 * Validate and canonicalize a capability token list: every entry must be a
 * known `CAPABILITY_TOKENS` member (unknown or malformed tokens fail closed),
 * duplicates collapse, and the result is frozen in canonical
 * `CAPABILITY_TOKENS` order so serialization, audit records, and digests are
 * deterministic.
 */
export function canonicalizeCapabilityTokens(
  tokens: unknown,
  field: string,
): readonly CapabilityToken[] {
  if (!Array.isArray(tokens)) {
    throw new Error(`Shard capability derivation: ${field} must be an array of capability tokens`);
  }
  const unique = new Set<CapabilityToken>();
  for (const entry of tokens) {
    if (!isCapabilityToken(entry)) {
      throw new Error(
        `Shard capability derivation: ${field} contains unknown capability token "${String(entry)}"`,
      );
    }
    unique.add(entry);
  }
  const ordered = [...unique].sort(
    (a, b) => (CAPABILITY_TOKEN_ORDER.get(a) ?? -1) - (CAPABILITY_TOKEN_ORDER.get(b) ?? -1),
  );
  return Object.freeze(ordered);
}

/**
 * The complete standing shard denial mask (canonical order). These ten tokens
 * are removed from every derived shard grant regardless of parent authority.
 * Rationale per token lives in docs/shard-capability-tier-derivation.md.
 *
 * The four `external.*` egress tokens are masked so a shard never holds
 * standing outbound-communication authority: `notify` (the operator emergency
 * button) and every other external-send surface are operator-only, not a
 * companion surface a shard may drive. Name-blocking the tool is the first
 * line (BLOCKED_SHARD_TOOL_NAMES); dropping the capability tokens is the
 * defense-in-depth backstop so a renamed or newly injected external-send tool
 * cannot regain egress merely because a parent has it.
 */
export const SHARD_CAPABILITY_DENIAL_MASK: readonly CapabilityToken[] = canonicalizeCapabilityTokens(
  [
    'identity.write.base',
    'identity.write.operator',
    'memory.delete',
    'external.discord',
    'external.email',
    'external.web',
    'external.companion',
    'lifecycle.restart',
    'lifecycle.rebuild',
    'world.control',
  ],
  'SHARD_CAPABILITY_DENIAL_MASK',
);

export type ShardDenialMaskToken =
  | 'identity.write.base'
  | 'identity.write.operator'
  | 'memory.delete'
  | 'external.discord'
  | 'external.email'
  | 'external.web'
  | 'external.companion'
  | 'lifecycle.restart'
  | 'lifecycle.rebuild'
  | 'world.control';

const SHARD_DENIAL_MASK_SET: ReadonlySet<CapabilityToken> = new Set(SHARD_CAPABILITY_DENIAL_MASK);

/**
 * Explicit per-token temporary-grant eligibility for every masked token.
 *
 * - `requestScoped: 'human-approval-required'` — eligible only through the
 *   exceptional-action path after explicit human approval, bound to one
 *   parent, shard instance, request, normalized action, and effector scope.
 * - `ttl: 'policy-gated-disabled'` — TTL authority is disabled by default and
 *   may be offered only once a separately approved canonical JSON-owned server
 *   policy exists (not selected by this contract).
 * - `'never'` — nondelegable in both request-scoped and TTL form.
 *
 * No disposition ever mutates the standing custom token set or the parent's
 * capability owner file.
 */
export interface ShardMaskTemporaryGrantDisposition {
  readonly requestScoped: 'human-approval-required' | 'never';
  readonly ttl: 'policy-gated-disabled' | 'never';
}

export const SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS: Readonly<
  Record<ShardDenialMaskToken, ShardMaskTemporaryGrantDisposition>
> = Object.freeze({
  'identity.write.base': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'identity.write.operator': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'memory.delete': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'external.discord': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'external.email': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'external.web': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'external.companion': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'lifecycle.restart': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'lifecycle.rebuild': Object.freeze({ requestScoped: 'never', ttl: 'never' } as const),
  'world.control': Object.freeze({
    requestScoped: 'human-approval-required',
    ttl: 'policy-gated-disabled',
  } as const),
});

/**
 * One validated read of the parent's authoritative capability owner content.
 * `customTokens` MUST come from the same parsed owner value as `tier`;
 * assembling this input from independently refreshing getters is forbidden
 * (see CapabilityRuntime.snapshotOwnerGrant for the disk-backed source).
 */
export interface ShardParentGrantInput {
  /** Authenticated parent companion ID. */
  readonly companionId: string;
  /** Parent tier from the validated owner content. */
  readonly tier: CapabilityTier;
  /**
   * Authoritative `customTokens` from the same validated owner content.
   * REQUIRED when `tier === 'custom'` — re-resolving a custom parent from only
   * its tier name would produce an empty and incorrect grant, so that case
   * fails closed instead.
   */
  readonly customTokens?: readonly unknown[];
}

/** Atomic authoritative parent grant snapshot (canonical, frozen). */
export interface ShardParentGrantSnapshot {
  readonly companionId: string;
  readonly tier: CapabilityTier;
  /** Effective parent tokens in canonical order. */
  readonly tokens: readonly CapabilityToken[];
  /** Content-stable owner version (SHA-256 of canonical owner content). */
  readonly ownerVersion: string;
}

/**
 * Compute the content-stable owner version from canonical validated owner
 * content. Equal canonical content yields the same version in any process;
 * the version never depends on mtimes, paths, or cache state.
 */
export function computeCapabilityOwnerVersion(content: {
  readonly tier: CapabilityTier;
  readonly customTokens?: readonly unknown[];
}): string {
  if (!isCapabilityTier(content.tier)) {
    throw new Error(
      `Shard capability derivation: unknown capability tier "${String(content.tier)}"`,
    );
  }
  const customTokens = canonicalizeCapabilityTokens(
    content.customTokens ?? [],
    'customTokens',
  );
  const payload = JSON.stringify({
    contract: CAPABILITY_OWNER_VERSION_CONTRACT,
    tier: content.tier,
    customTokens,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Build the atomic parent grant snapshot from one validated owner read.
 * Fails closed on a missing/blank companion ID, an unknown tier, an unknown
 * token, or a custom parent without its authoritative `customTokens`.
 */
export function createShardParentGrantSnapshot(
  input: ShardParentGrantInput,
): ShardParentGrantSnapshot {
  // Callers may hand this untyped boundary data; re-validate at runtime.
  const companionId: unknown = input.companionId;
  if (typeof companionId !== 'string' || companionId.trim().length === 0) {
    throw new Error('Shard capability derivation: companionId must be a non-empty string');
  }
  if (!isCapabilityTier(input.tier)) {
    throw new Error(
      `Shard capability derivation: unknown capability tier "${String(input.tier)}"`,
    );
  }

  let tokens: readonly CapabilityToken[];
  if (input.tier === 'custom') {
    if (input.customTokens === undefined) {
      throw new Error(
        'Shard capability derivation: a custom parent requires its authoritative customTokens; '
        + 'refusing to resolve a custom grant from the tier name alone',
      );
    }
    tokens = canonicalizeCapabilityTokens(input.customTokens, 'customTokens');
  } else {
    // Default tiers resolve from the canonical tier definition; the owner's
    // inert customTokens are still validated and folded into the owner version
    // below because they are part of the canonical owner content.
    canonicalizeCapabilityTokens(
      input.customTokens === undefined ? [] : input.customTokens,
      'customTokens',
    );
    tokens = canonicalizeCapabilityTokens([...CAPABILITY_TIER_DEFAULTS[input.tier]], `tier "${input.tier}" defaults`);
  }

  const ownerVersion = computeCapabilityOwnerVersion({
    tier: input.tier,
    ...(input.customTokens === undefined ? {} : { customTokens: input.customTokens }),
  });

  return Object.freeze({
    companionId: input.companionId,
    tier: input.tier,
    tokens,
    ownerVersion,
  });
}

/**
 * Immutable derived shard access: always tier `custom`, always exactly the
 * derived token set, and carries the owner version / grant digest metadata the
 * manager and gateway use for the launch handshake.
 */
export interface ShardCapabilityAccess extends CapabilityAccess {
  readonly derivationVersion: string;
  readonly ownerVersion: string;
  readonly grantDigest: string;
}

/** Full derivation result (frozen). */
export interface DerivedShardCapabilityGrant {
  readonly derivationVersion: string;
  readonly parent: ShardParentGrantSnapshot;
  /** The standing denial mask applied (canonical order, all ten tokens). */
  readonly denialMask: readonly CapabilityToken[];
  /** Derived shard tokens: parent tokens minus the mask, canonical order. */
  readonly tokens: readonly CapabilityToken[];
  /** Equals parent.ownerVersion; repeated for handshake ergonomics. */
  readonly ownerVersion: string;
  /** SHA-256 digest over the canonical derivation payload. */
  readonly grantDigest: string;
  /** Immutable `custom` access advertising exactly `tokens`. */
  readonly access: ShardCapabilityAccess;
}

/**
 * Canonical digest payload contract. Exposed (frozen) so tests and structured
 * audit evidence can record exactly what the digest binds without being able
 * to mutate the contract.
 */
export interface ShardGrantDigestPayload {
  readonly contract: string;
  readonly parentCompanionId: string;
  readonly ownerVersion: string;
  readonly parentTier: CapabilityTier;
  readonly parentTokens: readonly CapabilityToken[];
  readonly denialMask: readonly CapabilityToken[];
  readonly shardTokens: readonly CapabilityToken[];
}

export function buildShardGrantDigestPayload(input: {
  readonly parent: ShardParentGrantSnapshot;
  readonly denialMask: readonly CapabilityToken[];
  readonly shardTokens: readonly CapabilityToken[];
  readonly derivationVersion?: string;
}): ShardGrantDigestPayload {
  return Object.freeze({
    contract: input.derivationVersion ?? SHARD_GRANT_DERIVATION_VERSION,
    parentCompanionId: input.parent.companionId,
    ownerVersion: input.parent.ownerVersion,
    parentTier: input.parent.tier,
    parentTokens: canonicalizeCapabilityTokens([...input.parent.tokens], 'parentTokens'),
    denialMask: canonicalizeCapabilityTokens([...input.denialMask], 'denialMask'),
    shardTokens: canonicalizeCapabilityTokens([...input.shardTokens], 'shardTokens'),
  });
}

/** SHA-256 hex digest of the canonical serialization of the payload. */
export function computeShardGrantDigest(payload: ShardGrantDigestPayload): string {
  const canonical = JSON.stringify({
    contract: payload.contract,
    parentCompanionId: payload.parentCompanionId,
    ownerVersion: payload.ownerVersion,
    parentTier: payload.parentTier,
    parentTokens: payload.parentTokens,
    denialMask: payload.denialMask,
    shardTokens: payload.shardTokens,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function immutableTokenSet(tokens: readonly CapabilityToken[]): ReadonlySet<CapabilityToken> {
  const set = new Set<CapabilityToken>(tokens);
  const reject = (): never => {
    throw new Error('Shard capability access is immutable');
  };
  Object.defineProperties(set, {
    add: { value: reject },
    delete: { value: reject },
    clear: { value: reject },
  });
  return Object.freeze(set) as ReadonlySet<CapabilityToken>;
}

/**
 * Derive the immutable shard capability grant from one atomic authoritative
 * parent owner read. This is the single canonical primitive both the shard
 * manager (launch) and the gateway (backend admission) must call; neither may
 * re-implement the mask, the subtraction, or the digest.
 */
export function deriveShardCapabilityGrant(
  input: ShardParentGrantInput,
): DerivedShardCapabilityGrant {
  const parent = createShardParentGrantSnapshot(input);
  const tokens = Object.freeze(
    parent.tokens.filter(token => !SHARD_DENIAL_MASK_SET.has(token)),
  );
  const payload = buildShardGrantDigestPayload({
    parent,
    denialMask: SHARD_CAPABILITY_DENIAL_MASK,
    shardTokens: tokens,
  });
  const grantDigest = computeShardGrantDigest(payload);
  const grantedTokens = immutableTokenSet(tokens);
  const access: ShardCapabilityAccess = Object.freeze({
    derivationVersion: SHARD_GRANT_DERIVATION_VERSION,
    ownerVersion: parent.ownerVersion,
    grantDigest,
    getTier: (): CapabilityTier => 'custom',
    getGrantedTokens: (): ReadonlySet<CapabilityToken> => grantedTokens,
    has: (token: CapabilityToken): boolean => grantedTokens.has(token),
  });

  return Object.freeze({
    derivationVersion: SHARD_GRANT_DERIVATION_VERSION,
    parent,
    denialMask: SHARD_CAPABILITY_DENIAL_MASK,
    tokens,
    ownerVersion: parent.ownerVersion,
    grantDigest,
    access,
  });
}

/**
 * Derive from one gateway-owned atomic snapshot and verify that its advertised
 * effective tokens agree with its tier/custom-token owner content. This is
 * the cross-process admission primitive for both backend launch and workload
 * registration; inconsistent owner snapshots fail closed.
 */
export function deriveShardCapabilityGrantFromSnapshot(
  companionId: string,
  snapshot: CapabilityGrantSnapshot,
): DerivedShardCapabilityGrant {
  const grant = deriveShardCapabilityGrant({
    companionId,
    tier: snapshot.tier,
    customTokens: snapshot.customTokens,
  });
  const effectiveTokens = canonicalizeCapabilityTokens(
    snapshot.grantedTokens,
    'snapshot.grantedTokens',
  );
  if (effectiveTokens.length !== grant.parent.tokens.length
    || effectiveTokens.some((token, index) => token !== grant.parent.tokens[index])) {
    throw new Error(
      'Atomic capability snapshot effective tokens do not match its owner tier/customTokens',
    );
  }
  return grant;
}
