# Shard capability-tier derivation

Status: approved design for `psfn-framework-yijy.1` (operator direction,
2026-07-17). This document specifies the follow-up implementation; it does not
change runtime behavior by itself.

## Decision

A shard does not choose a capability tier. At launch, the runtime resolves the
parent companion's effective capability grant and derives an immutable shard
grant from it:

```text
parentGrant = authoritative effective tokens for the parent companion
shardGrant  = parentGrant − SHARD_CAPABILITY_DENIAL_MASK

shardAccess = {
  tier: "custom",
  customTokens: shardGrant
}
```

`parentGrant` means the tokens returned by the parent's authoritative
`CapabilityAccess`. It is not the default token list inferred from a tier name
and is not a tier or token list supplied by a shard request. This distinction is
required for a parent whose owner file selects `custom`.

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

The canonical implementation should be one pure capability-system helper used
by both the shard manager and gateway. It should iterate the canonical
`CAPABILITY_TOKENS` order so audit records and equality checks are deterministic.
Unknown or malformed tokens must be rejected before launch rather than ignored.

The existing `ShardConfig.capabilities` and `requiredCapabilities` arrays are
routing diagnostics. They are not authorization inputs and must not be reused as
the parent or derived capability grant.

## Standing denial mask

The complete standing mask contains six tokens:

| Token | Rationale |
| --- | --- |
| `world.control` | Physical and virtual effectors, including satellite-hub objects, remain under the primary companion's precedence. A shard may inherit `world.read`, but never standing actuation authority. A task-specific control request uses the scoped temporary-grant path instead. |
| `lifecycle.restart` | The parent companion, shard manager, and gateway own process lifecycle. A task copy must not restart the primary runtime or its own managed backend from inside the task loop. |
| `lifecycle.rebuild` | Rebuild is a deployment operation with a larger and less reversible blast radius than restart. It remains with the parent/operator lifecycle boundary. |
| `identity.write.base` | Base identity is canonical shared identity state. Allowing a shard copy to stage or commit base-layer changes creates competing authors and an unsafe fold-back ambiguity. |
| `identity.write.operator` | The operator layer represents human-owned direction and is never delegated to a task copy. A shard must not edit or impersonate operator authority. |
| `memory.delete` | Shard memory mutation already flows through isolated staging, sync policy, and fold review; delete/redact/restore operations are currently denied on shard-to-prime sync. Removing the token as well is defense-in-depth: a newly injected or renamed memory tool must not gain destructive memory authority merely because a parent has it. |

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

Temporary grants are also separate from the standing grant. When a shard needs a
masked capability during a task, the approval route may issue a grant scoped to
that shard and request (or to a bounded TTL). It must not mutate the shard's
standing custom token set or the parent's owner file.

## Computation and enforcement seams

### Shared derivation primitive

The capability system should own a focused helper, rather than duplicating the
mask or set subtraction in the shard and gateway domains. Its input is an
authoritative `CapabilityAccess` snapshot; its output is an immutable
`CapabilityAccess` whose tier is `custom` and whose granted tokens are the
derived set.

The helper must:

1. Read the parent tier and granted-token set once for a consistent launch
   snapshot.
2. Validate every input token against `CAPABILITY_TOKENS`.
3. Remove exactly the six mask members above.
4. Return tokens in canonical order with no duplicates.
5. Expose the mask for tests and structured audit evidence without making it
   mutable.

The helper must not accept a caller-selected child tier. It must also avoid
re-resolving a `custom` parent from only its tier name, because doing so without
the owner's `customTokens` produces an empty and incorrect grant.

### Shard spawn

Both `ShardManager.spawn` and `ShardManager.delegateSatelliteSession` converge
on the execution path in `src/faculties/shards/manager.ts`. Derivation must occur
before a shard is registered, a shard Postgres schema is prepared, a backend is
requested, or an LLM turn begins.

The manager must receive a parent `CapabilityAccess` provider from startup
composition. At each launch it must:

1. Resolve the parent access and fail closed if it is unavailable or malformed.
2. Require the parent access to grant `shard.spawn`.
3. Derive one immutable custom shard access snapshot with the shared helper.
4. Inject that access into the shard `SubstrateAgent`; copying only
   `config.capabilityTier` is insufficient because the current no-runtime
   `SubstrateAgent` path resolves `custom` without explicit tokens.
5. Use the same access for tool gates, tool-availability prompt metadata, active
   shard state, results, and audit fields. A tier-based toolset may select a
   candidate catalog, but the derived token set is the final authorization
   boundary.

The manager must not grant a requested token from
`ShardConfig.capabilities`. Required routing capabilities may narrow where a
workload can run, but cannot widen `shardGrant`.

An audit record should identify the parent tier, derived tier (`custom`), the
canonical derived tokens, and the mask version or canonical mask. It must not
claim a shard started until derivation and the `shard.spawn` check succeed.

### Gateway shard-backend admission

`src/boundary/gateway/methods/shard-backends.ts` is an independent trust
boundary. It must recompute the grant from gateway-owned, authenticated parent
access; it must not trust a tier or token set declared in
`ShardBackendRequestParams`.

The gateway capability resolver already owns strict per-companion
`CapabilityAccess` resolution. Gateway method wiring should expose that strict
access to shard-backend admission, bound to the authenticated connection's
parent companion. Admission must fail closed when the companion identity, owner
file, access provider, or token validation is unavailable.

Backend admission retains the existing shell allowlist, approval, and
autonomous/custom backend restrictions. In addition, it must require the
authoritative parent grant to contain `shard.spawn`, derive the shard grant with
the shared helper, and pass that server-owned grant to the eventual backend
executor. A custom parent tier without `shard.spawn` is denied even though its
tier name is `custom`.

The current caller-declared `capabilityTier` field is diagnostic only and is
already ignored by authorization. The implementation should remove it from the
request contract rather than replace it with caller-declared `customTokens`.
No compatibility reader or fallback is required. If the backend executor needs
the derived grant, the gateway supplies it through a server-owned execution
context or result internal to the boundary.

The manager and gateway checks are deliberately redundant:

| Boundary | Authoritative input | Required decision |
| --- | --- | --- |
| Manager launch | Parent runtime `CapabilityAccess` | Parent has `shard.spawn`; derive and inject the custom access before local execution. |
| Gateway admission | Strict per-authenticated-companion gateway `CapabilityAccess` | Parent satisfies existing backend-tier policy and has `shard.spawn`; independently derive the exact grant passed to the backend. |
| Shard tool execution | Immutable derived shard `CapabilityAccess` | Existing capability gates allow only tools/actions covered by the derived tokens. |

If the manager and gateway derive different grants from the same parent
snapshot, admission must stop. The discrepancy is a policy failure, not a reason
to choose the broader set.

## Required verification

Implementation tests should prove:

- autonomous and explicit-custom parent grants derive to `custom` with exactly
  the parent's tokens minus the six-token mask;
- nursery/apprentice/default/custom parents cannot gain tokens through
  derivation, and parents without `shard.spawn` cannot launch;
- all six mask members remain absent even when the parent grants all capability
  tokens;
- `identity.write.runtime`, `memory.write`, and other unmasked tokens survive
  only when the parent grants them;
- custom-parent tokens come from authoritative `customTokens`, not tier-name
  defaults;
- both normal and Wyoming shard entrypoints inject the derived access before
  execution;
- tool eligibility and prompt availability use the derived token set rather
  than treating `custom` as an empty grant or an unrestricted tier;
- gateway admission ignores/removes caller tier authority, resolves the
  authenticated companion's access, denies missing `shard.spawn`, and fails
  closed on resolver or owner-file errors;
- the existing six-token mask and independent recursion, memory-fold, shell
  allowlist, approval, and multi-companion isolation boundaries remain intact.

## Non-goals

- Adding a capability tier enum value.
- Changing or adding fields to `capability-tier.json`.
- Giving shards standing `world.control` or broadening the denial mask through
  task requests.
- Replacing shard tool injection, memory isolation/fold review, gateway policy,
  or temporary-grant approval with tier derivation.
- Designing the companion-app approval UX or the consolidated Garden; those are
  sibling design scopes.
