# Unified Approval Envelope

Status: normative contract + gateway projection shipped (beads `psfn-framework-ct0v`,
`psfn-framework-13sk`). Design direction from the Shard Approval contract
(`companion-ui/SHARD_APPROVALS.md`, operator directive 2026-07-17).

## Why

Several PSFN subsystems need to route the same shape of question to an
authenticated decision-maker's device: *"an authenticated part of me wants to
do X — decide."* Depending on the action and policy, that person may be the
**Partner** or an administrative **Operator**. Historically each
grew its own payload. This document defines ONE envelope so every such request
projects into the same relay path (`companion.approval.requested` /
`companion.approval.resolved`) and renders through one request-card contract on
the app.

The envelope is a **redacted, allowlisted projection**, never a view onto raw
state. It carries no tool params, prompts, task text, chain-of-thought,
filesystem paths, credentials, or grant secrets. Identity, scope, and grant
offer are **resolved server-side from authenticated lineage** and are never
trusted from client-supplied fields.

## The envelope

Canonical types live in `src/shared/contracts/approval-envelope.ts` and are
consumed/re-exported by `src/shared/contracts/companion-relay.ts`. The wire
realization is `CompanionApprovalRequestedPayload`: the original **v1** fields
plus the **v2** fields below, all additive and optional.

| Field | v | Meaning |
| --- | --- | --- |
| `id` | v1 | Approval / request id. The queue key — possession is never authority. |
| `title` | v1 | Redacted `action: scope` summary. |
| `requestedAt` / `expiresAt?` | v1 | ISO create / expiry. |
| `redactedContext` | v1 | Redacted companion-authored reason. |
| `status` | v1 | Always `pending` on the request event. |
| `sourceSystem` | v2 | Which subsystem raised it (tag only, not authority). |
| `attribution` | v2 | Server-resolved lineage: `{ parentLabel, parentId, shardLabel?, shardId? }`. Ids opaque, labels presentation-only. |
| `action` / `scope` / `reason` | v2 | Redacted strings (the card breaks out what `title`/`redactedContext` fold together). |
| `grantMode` | v2 | The grant the server is **offering**: `{ kind: 'once' }` or (contract-only) `{ kind: 'ttl', ttlSeconds }`. |

### Source-system registry

`ApprovalSourceSystem` is an **open** string union — a new projector can add a
tag without a breaking change. The production registry only lists projectors
that are wired:

| Tag | Projector | Status |
| --- | --- | --- |
| `tool-access` | gateway confirmation gate — tool / information-access escalation | **projecting now** |

Future expensive-usage, shard, and CogSec producers are not registered source
systems until they have a real projection path.

### Grant modes

- `once` — request-scoped, the default and today the **only** mode the server may
  emit. Authorizes the exact queued operation one time; the queue consumes the
  authorization on execution, leaving no residual capability.
- `ttl` — time-limited. **Contract-only.** The union carries it so app and wire
  agree on the shape, but the server MUST NOT emit `ttl` until the
  separately-approved JSON-owned TTL policy exists (eligible actions, maximum
  TTL, revocation, recovery — see `SHARD_APPROVALS.md` §Temporary Grant Semantics
  and `docs/shard-capability-tier-derivation.md`). `redactApprovalRequested`
  throws if handed a non-`once` mode, so a TTL offer cannot slip onto the wire.

## Routing rule — one relay path for all kinds

Every kind projects into the **same** two bus events, regardless of source:

```
companion.approval.requested  { companionId, payload, timestamp }
companion.approval.resolved   { companionId, payload, timestamp }
```

`companionId` is the authenticated parent-Companion owner and stays the routing /
ownership key (never replaced by a shard-derived id). Shard provenance rides
inside `payload.attribution.shardId` as optional provenance, not a peer identity.
The envelope is built once at the confirmation-queue choke point and fanned out;
the redaction whitelist runs at that single emission site.

## Fail-closed invariants (as wired)

- **Ownerless refusal preserved.** The emission observer in
  `src/boundary/gateway/approval-boundary.ts` still refuses to emit an approval
  with no authenticated owner.
- **Attribution equals the authenticated owner.** Attribution is resolved
  server-side: `parentId` is always the enqueue owner. If an enqueuer supplies
  its own attribution (a future shard path adding `shardId`), a `parentId` that
  does not equal the authenticated owner is refused rather than routed to a
  spoofed parent.
- **Explicit construction, never spread.** `redactApprovalRequested` builds every
  field (v1 and v2) from an allowlist. No object is spread from the queue entry
  to the wire, so raw params can never survive — proven by
  `redaction.test.ts`.
- **Immutable provenance in the queue.** `confirmation-queue.ts` carries optional
  `sourceSystem` / `attribution`, deep-copied on enqueue and on snapshot;
  ordinary entries omit both and behave exactly as before.

## Versioning — capability-gated emission, tolerant parsing

The companion-ui framing parser is strict-exact: naively adding wire fields would
drop the whole frame on deployed old clients (`HubFramingError`). Both sides are
handled:

1. **Server gate (deny by default).** The events SSE route
   (`src/channels/api/server/companion-relay-routes.ts`) emits the v2 fields
   only to a subscriber that advertised the `approvals.v2` capability (via the
   `caps` query token). Without it, `projectApprovalRequestedPayload` reconstructs
   the exact v1 subset — an old client's wire shape is unchanged. Only
   `approval.requested` is gated; other kinds pass through.
2. **Client tolerance.** `companion-ui/src/lib/protocol/framing.ts` adds the v2
   fields to the `approval.requested` validator's optional set AND tolerates
   (then drops) unknown future keys **for this message type only** — `exactRecord`
   is not globally relaxed, and every other message stays strict. The reducer
   (`hub-stream.ts`) lifts only known fields into `ApprovalStreamEntry`, so
   unknown keys never enter app state.

### Hub forwarding

The Companion UI reaches the gateway through the Satellite Hub. The Hub bridge
advertises its v2 parser to this SSE route with `caps=approvals.v2`, validates
the complete payload, and keeps it internally. Browser clients advertise
`approvals.v2` in `hello.eventCapabilities`; the Hub acknowledges that list and
forwards the complete payload only to those connections. Connections that omit
the event capability receive the explicit six-field v1 projection. The
gateway-owned WebSocket path uses the same explicit negotiation and requires
complete v2 data before emitting an approval event.

## Current projection scope

Projecting now:

- **gateway confirmation gate** → `sourceSystem: 'tool-access'`, parent
  attribution from the authenticated owner, `grantMode: { kind: 'once' }`.
- Eligible shard-originated exceptional actions traverse that same gateway
  projection. The gateway binds authenticated shard workload lineage, prepares
  and consumes an exact-once request grant, and includes optional `shardId` /
  `shardLabel` provenance. This does not create a separate source-system tag.
- Companion UI clients that negotiate `approvals.v2` render the known v2
  attribution, action, scope, reason, source, and grant-mode fields.

Deliberately **not** in this change (future beads):

- shard fold-review-specific projection beyond the gateway exceptional-action
  path;
- cogsec intake-quarantine and broadcast approvals migrating onto this envelope;
- TTL grant policy and emission (the current shard request grant is exact-once);
- direct shard chat.

The confirmation queue and contract already carry the optional shard provenance
those beads need, so they extend this seam rather than reshape it.
