# Shard capability-tier derivation

Status: approved design for `psfn-framework-yijy.1` (operator direction,
2026-07-17). This document specifies the follow-up implementation; it does not
change runtime behavior by itself.

## Decision

A shard does not choose a capability tier. At launch, the runtime atomically
snapshots the parent companion's effective capability grant and derives an
immutable shard grant from that one snapshot:

```text
parentSnapshot = snapshotAuthoritativeParentGrant()
shardGrant     = parentSnapshot.tokens − SHARD_CAPABILITY_DENIAL_MASK
grantDigest    = digest(parentSnapshot, derivationVersion, shardGrant)

shardAccess = {
  tier: "custom",
  customTokens: shardGrant,
  ownerVersion: parentSnapshot.ownerVersion,
  grantDigest
}
```

`parentSnapshot.tokens` means the effective tokens resolved from one validated
read of the parent's authoritative capability owner. It is not the default
token list inferred from a tier name and is not a tier or token list supplied by
a shard request. This distinction is required for a parent whose owner file
selects `custom`.

The snapshot operation is a single authority API. Calling
`CapabilityAccess.getTier()` and `getGrantedTokens()` in sequence is not a
snapshot: both getters may refresh, so an owner-file update between them can
mix two versions. The atomic result contains the parent tier, canonical parent
tokens, and an `ownerVersion` computed from the canonical validated owner
content. The owner version must be content-stable across processes and must not
depend on process-local cache state.

The `grantDigest` is a SHA-256 digest of a canonical serialization containing:

- the shard-grant derivation contract version;
- the authenticated parent companion ID;
- `ownerVersion`, parent tier, and canonical parent tokens;
- the canonical ten-token denial mask; and
- the canonical derived shard tokens.

This makes an authority change, derivation-rule change, companion mismatch, or
grant change observable at the gateway even when the human-readable tier name
does not change. The manager binds the launch to `ownerVersion` and
`grantDigest`; the gateway independently takes one atomic snapshot, recomputes
both values, and requires exact equality before backend side effects.

The derived grant has these invariants:

- Every shard token was effective for its parent at launch.
- No token in the shard denial mask is in the standing shard grant.
- The shard is represented through the existing `custom` tier and explicit
  token set. There is no `shard` tier enum value.
- Derivation does not read, write, copy, or extend the
  `capability-tier.json` owner-file format. The custom access is an in-memory
  launch artifact.
- A parent owner-file change affects future launches. A running shard retains
  its launch snapshot; revoking that snapshot requires the shard manager to
  terminate and relaunch the shard.
- A backend launch is admitted only when the manager-bound owner version and
  grant digest exactly match the gateway's atomic snapshot. Owner authority
  churn between the two checks denies that launch.

The canonical implementation should be one pure capability-system helper used
by both the shard manager and gateway. It should iterate the canonical
`CAPABILITY_TOKENS` order so audit records, canonical serialization, and digest
checks are deterministic. Unknown or malformed tokens must be rejected before
launch rather than ignored.

`ShardConfig.capabilities` is a routing advertisement used for diagnostics.
`ShardConfig.requiredCapabilities` is a narrowing routing constraint checked
against the advertised route capabilities. Neither is an authorization input,
and neither may be reused as or widen the parent snapshot or derived grant.

## Standing denial mask

The complete standing mask contains ten tokens:

| Token | Rationale |
| --- | --- |
| `world.control` | Physical and virtual effectors, including satellite-hub objects, remain under the primary companion's precedence. A shard may inherit `world.read`, but never standing actuation authority. A task-specific control request uses the scoped temporary-grant path instead. |
| `lifecycle.restart` | The parent companion, shard manager, and gateway own process lifecycle. A task copy must not restart the primary runtime or its own managed backend from inside the task loop. |
| `lifecycle.rebuild` | Rebuild is a deployment operation with a larger and less reversible blast radius than restart. It remains with the parent/operator lifecycle boundary. |
| `identity.write.base` | Base identity is canonical shared identity state. Allowing a shard copy to stage or commit base-layer changes creates competing authors and an unsafe fold-back ambiguity. |
| `identity.write.operator` | The operator layer represents human-owned direction and is never delegated to a task copy. A shard must not edit or impersonate operator authority. |
| `memory.delete` | Shard memory mutation already flows through isolated staging, sync policy, and fold review; delete/redact/restore operations are currently denied on shard-to-prime sync. Removing the token as well is defense-in-depth: a newly injected or renamed memory tool must not gain destructive memory authority merely because a parent has it. |
| `external.discord` | Standing outbound communication is not a shard authority. The `notify` tool is the operator emergency button (contact the operator when a normal channel is down), never a companion surface a task copy may drive. `notify` is name-blocked at injection (`BLOCKED_SHARD_TOOL_NAMES`); masking the egress token as well is defense-in-depth so a renamed or newly injected external-send tool cannot regain Discord egress merely because a parent has it. |
| `external.email` | Same rationale as `external.discord`: no standing email egress for a shard. |
| `external.web` | Same rationale: the operator-directed `notify` brief/clarify/approval_request paths and any other `external.web`-gated egress are not a standing shard authority. |
| `external.companion` | Companion-to-companion outreach (`notify` send/consider to a contact) is a primary-companion surface, not a shard authority. |

Tokens not in this table are not globally promised to every shard. They remain
only when the parent actually has them. In particular,
`identity.write.runtime` and `memory.write` may survive derivation so a task can
produce runtime-persona or memory candidates, while the existing shard
staging/fold policy continues to govern whether those candidates reach canonical
state.

Recursive task creation is a separate invariant, not a seventh tier-mask
decision. `ShardManager` currently removes subagent recursion and tool-loading
surfaces before injection. That manager/runtime restriction remains in force
even when the derived grant contains `shard.spawn` or `subagent.spawn`; this
design does not broaden recursive spawning.

Temporary authority is separate from the standing grant and is not available
uniformly across the mask:

| Token | Request-scoped authority | TTL authority | Disposition |
| --- | --- | --- | --- |
| `world.control` | Eligible only after explicit Operator approval, bound to one parent, shard instance, request, normalized action, and effector scope. | Disabled by default. It may be offered only when a separately approved canonical JSON-owned server policy defines the eligible actions, maximum TTL, revocation, and recovery rules. Browser state, environment values, and shard input are never policy authority. | Delegable only through the exceptional-action path; it never enters the standing custom token set. |
| `lifecycle.restart` | Never. | Never. | Nondelegable: lifecycle remains with the parent, shard manager, gateway, and operator. |
| `lifecycle.rebuild` | Never. | Never. | Nondelegable: rebuild remains an operator/deployment action. |
| `identity.write.base` | Never. | Never. | Nondelegable: shards cannot temporarily become competing authors of canonical base identity. |
| `identity.write.operator` | Never. | Never. | Nondelegable: operator authority cannot be lent to a shard. |
| `memory.delete` | Never. | Never. | Nondelegable: destructive memory authority remains behind isolation, fold review, and prime-owned policy. |
| `external.discord` | Never. | Never. | Nondelegable: outbound communication egress is operator-only and is never lent to a task copy. |
| `external.email` | Never. | Never. | Nondelegable: same as `external.discord`. |
| `external.web` | Never. | Never. | Nondelegable: same as `external.discord`. |
| `external.companion` | Never. | Never. | Nondelegable: companion outreach is a primary-companion surface, never a shard authority. |

Request-scoped `world.control` authority is exact-use and cannot be auto-cleared
from the parent's autonomous tier. TTL support remains unavailable until the
separate canonical server-policy ownership decision is implemented; this design
does not select or change an owner-file format. Every exceptional authorization
is evaluated at the action boundary and must not mutate the shard's standing
custom token set or the parent's capability owner file.

## Computation and enforcement seams

### Shared derivation primitive

The capability system should own a focused helper, rather than duplicating the
mask or set subtraction in the shard and gateway domains. Its input is one
atomic authoritative parent grant snapshot; its output is an immutable
`CapabilityAccess` whose tier is `custom`, whose granted tokens are the derived
set, and whose metadata carries the owner version and grant digest.

The helper must:

1. Load and validate the parent owner once, resolving the tier and token set
   from that same parsed value. Independent refreshing getters are forbidden.
2. Validate every input token against `CAPABILITY_TOKENS`.
3. Remove exactly the ten mask members above.
4. Return tokens in canonical order with no duplicates.
5. Compute a content-stable owner version and the canonical SHA-256 grant digest
   defined above.
6. Expose the mask, derivation version, and digest input contract for tests and
   structured audit evidence without making them mutable.

The helper must not accept a caller-selected child tier. It must also avoid
re-resolving a `custom` parent from only its tier name, because doing so without
the owner's `customTokens` produces an empty and incorrect grant.

### Shard spawn

Both `ShardManager.spawn` and `ShardManager.delegateSatelliteSession` converge
on the execution path in `src/faculties/shards/manager.ts`. Derivation must occur
before a shard is registered, a shard Postgres schema is prepared, a backend is
requested, or an LLM turn begins.

The manager must receive an atomic parent grant snapshot provider from startup
composition. At each launch it must:

1. Resolve one parent snapshot and fail closed if it is unavailable or
   malformed.
2. Require that snapshot to grant `shard.spawn`.
3. Derive one immutable custom shard access, owner version, and grant digest
   with the shared helper.
4. Inject that access into the shard `SubstrateAgent`; copying only
   `config.capabilityTier` is insufficient because the current no-runtime
   `SubstrateAgent` path resolves `custom` without explicit tokens.
5. Use the same access for tool gates, tool-availability prompt metadata, active
   shard state, results, and audit fields. A tier-based toolset may select a
   candidate catalog, but the derived token set is the final authorization
   boundary.
6. Bind every gateway backend request to the authenticated parent companion,
   shard ID, `ownerVersion`, and `grantDigest`.

The manager must not grant a token from `ShardConfig.capabilities` or
`ShardConfig.requiredCapabilities`. The former advertises a route for
diagnostics and the latter may reject a route that lacks a requirement; neither
can widen `shardGrant`.

An audit record should identify the parent tier, derived tier (`custom`), the
canonical derived tokens, owner version, grant digest, and mask/derivation
version. It must not claim a shard started until snapshot, derivation, digest
binding, and the `shard.spawn` check succeed.

### Gateway shard-backend admission

`src/boundary/gateway/methods/shard-backends.ts` is an independent trust
boundary. It must take one atomic snapshot and recompute the grant from
gateway-owned, authenticated parent authority; it must not trust a tier or token
set declared in `ShardBackendRequestParams`.

The gateway capability resolver already owns strict per-companion
capability resolution. Gateway method wiring should expose the atomic snapshot
operation to shard-backend admission, bound to the authenticated connection's
parent companion. Admission must fail closed when the companion identity, owner
file, snapshot provider, owner version, digest computation, or token validation
is unavailable.

Backend admission retains the existing shell allowlist, approval, and
autonomous/custom backend restrictions. In addition, it must require the
authoritative parent grant to contain `shard.spawn`, derive the shard grant with
the shared helper, and compare the recomputed `ownerVersion` and `grantDigest`
exactly with the manager-bound request. A custom parent tier without
`shard.spawn` is denied even though its tier name is `custom`.

The current caller-declared `capabilityTier` field is diagnostic only and is
already ignored by authorization. The implementation should remove it from the
request contract rather than replace it with caller-declared `customTokens`.
The replacement request contract requires `ownerVersion` and `grantDigest` as
manager-bound assertions, not as authority: the gateway recomputes both. No
compatibility reader or fallback is required.

After equality succeeds, the gateway creates one server-owned authorized launch
context containing the recomputed immutable shard access and consumes that same
context in the backend executor. It must not rehydrate authority from request
fields or independently refreshing getters. Immediately before the first
backend side effect, the executor boundary must verify that the current
authoritative owner version still equals the admitted owner version. A mismatch
at either comparison denies without registering, preparing, starting, or
mutating a backend. Once admitted and consumed, the immutable launch snapshot
governs that shard; a later owner change follows the running-shard
termination/relaunch rule rather than silently recomputing a broader grant.

The manager and gateway checks are deliberately redundant:

| Boundary | Authoritative input | Required decision |
| --- | --- | --- |
| Manager launch | Atomic parent grant snapshot | Parent has `shard.spawn`; derive and inject the custom access, then bind owner version and digest before local/backend execution. |
| Gateway admission | Atomic strict per-authenticated-companion grant snapshot | Parent satisfies existing backend-tier policy and has `shard.spawn`; owner version and recomputed digest exactly match the manager assertions. |
| Backend execution | Server-owned authorized launch context plus current owner-version check | No owner churn occurred before the first backend side effect; execute with the already-admitted immutable access. |
| Shard tool execution | Immutable derived shard `CapabilityAccess` | Existing capability gates allow only tools/actions covered by the derived tokens. |

If the manager and gateway resolve different owner versions or grant digests,
admission must stop. The discrepancy is a policy/TOCTOU failure, not a reason to
choose the newer, older, or broader set.

## Filed implementation graph

The coordinated implementation is filed under `psfn-framework-mus2`:

- `psfn-framework-mus2.1` owns the atomic authoritative snapshot, canonical
  derivation, immutable custom access, owner version, and grant digest.
- `psfn-framework-mus2.4` binds normal and Wyoming `ShardManager` launches to
  that snapshot and propagates the digest.
- `psfn-framework-mus2.5` recomputes and requires digest equality at gateway
  backend admission.
- `psfn-framework-mus2.7` owns the per-token temporary-authority policy,
  including request-only `world.control`, policy-gated optional TTL, and
  nondelegability for the other five mask tokens.

## Required verification

Implementation tests should prove:

- autonomous and explicit-custom parent grants derive to `custom` with exactly
  the parent's tokens minus the ten-token mask;
- nursery/apprentice/default/custom parents cannot gain tokens through
  derivation, and parents without `shard.spawn` cannot launch;
- all ten mask members remain absent even when the parent grants all capability
  tokens, including every `external.*` egress token;
- `identity.write.runtime`, `memory.write`, and other unmasked tokens survive
  only when the parent grants them;
- custom-parent tokens come from authoritative `customTokens`, not tier-name
  defaults;
- one atomic owner read cannot mix a tier from one owner version with tokens
  from another, including when the owner changes during snapshot acquisition;
- equal canonical owner content and grants produce stable owner versions and
  grant digests across manager and gateway processes, while any authority,
  parent identity, mask, derivation-version, or derived-token change changes the
  digest;
- both normal and Wyoming shard entrypoints inject the derived access before
  execution and bind the exact owner version and grant digest to backend
  requests;
- tool eligibility and prompt availability use the derived token set rather
  than treating `custom` as an empty grant or an unrestricted tier;
- gateway admission ignores/removes caller tier authority, resolves the
  authenticated companion's access, denies missing `shard.spawn`, and fails
  closed on resolver or owner-file errors;
- an owner-file authority change between manager snapshot and gateway snapshot
  produces an owner-version/digest mismatch and no backend side effect;
- an owner-file authority change between gateway admission and the executor's
  pre-side-effect check is also denied without a backend side effect;
- a matched admission passes the exact recomputed immutable access to execution
  without re-reading request authority or widening during owner churn;
- `ShardConfig.capabilities` remains diagnostic and
  `requiredCapabilities` remains narrowing-only; neither can change the digest
  or granted tokens;
- only `world.control` is eligible for exact request-scoped temporary authority;
  TTL remains unavailable without separately canonical JSON-owned server
  policy, and all nine other masked tokens reject both request and TTL authority;
- the existing ten-token mask and independent recursion, memory-fold, shell
  allowlist, approval, and multi-companion isolation boundaries remain intact.

## Non-goals

- Adding a capability tier enum value.
- Changing or adding fields to `capability-tier.json`.
- Giving shards standing `world.control` or broadening the denial mask through
  task requests.
- Adding a compatibility reader for the old shard-backend request contract.
- Selecting or changing the canonical JSON owner-file format for optional
  `world.control` TTL policy; TTL stays disabled until that separate ownership
  decision is implemented.
- Replacing shard tool injection, memory isolation/fold review, gateway policy,
  or temporary-grant approval with tier derivation.
- Designing the companion-app approval UX or the consolidated Garden; those are
  sibling design scopes.
