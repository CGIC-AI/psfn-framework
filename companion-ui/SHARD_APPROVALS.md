# Shard Approval And Direct-Chat Contract

Status: approved design direction; implementation pending.

Decision provenance: operator directive recorded on 2026-07-17 in
`psfn-framework-yijy.2`.

This specification extends the Companion UI approval and chat surfaces to
companion shards. It is a target contract, not a description of currently
shipped behavior.

The Companion UI remains a client of the authenticated Satellite Hub/gateway
path. It does not call PSFN core or `/api/admin/*`, hold approval authority, or
derive fleet or shard ownership in the browser.

## Scope

This contract covers:

- parent-companion ownership and shard provenance for shard-originated
  approval requests;
- server-side event subscription and fleet filtering;
- shards as visible, directly chat-addressable entities beneath their parent
  companion;
- contextual request cards in the Companion UI;
- request-scoped or time-limited temporary grants; and
- compatibility with existing non-shard approval flows.

It does not define shard capability-tier derivation, shard deployment, shard
identity issuance, or the inter-companion protocol (ICP). Those systems supply
trusted identity, lineage, and policy results to this boundary.

## Identity And Attribution

A shard-originated approval has two distinct identities:

- `companionId`: the owning **parent companion's** canonical CompanionId; and
- `shardId`: the opaque shard-instance identifier that records which child
  asked.

The existing `companionId` field remains the routing and ownership key. It is
not replaced with a shard-derived CompanionId. `shardId` is additional
provenance, not an owner and not a peer-companion identity.

Both values MUST come from authenticated server-side shard lineage or workload
registration. The boundary MUST NOT trust a parent ID, shard ID, shard label,
or grant scope supplied in tool parameters, request-card payloads, or browser
authority fields. Before enqueue, the gateway MUST verify all of the following:

1. the requesting workload is an authenticated shard;
2. the shard has one live, unambiguous parent-companion binding;
3. the authenticated parent binding equals `companionId`; and
4. the shard is eligible to request the gated action under its derived shard
   policy.

Missing, unknown, ambiguous, orphaned, or mismatched lineage is a denial. It
MUST NOT enqueue, emit an event, notify an operator, or fall back to a global
or default companion. The existing refusal to enqueue or emit ownerless
approvals remains mandatory.

Human-readable names are presentation only. A request card may show a
server-resolved shard label, but routing, resolution, grants, and audit records
key on canonical IDs.

## Approval Event Contract

The internal typed events retain the current parent owner and add optional
shard provenance:

```ts
interface CompanionApprovalRequestedEvent {
  companionId: CompanionId; // parent owner
  shardId?: ShardInstanceId;
  payload: CompanionApprovalRequestedPayload;
  timestamp: number;
}

interface CompanionApprovalResolvedEvent {
  companionId: CompanionId; // same parent owner as the request
  shardId?: ShardInstanceId;
  payload: CompanionApprovalResolvedPayload;
  timestamp: number;
}
```

For shard requests, `shardId` is required on both lifecycle events. For
ordinary companion requests it is absent, and the current event behavior is
unchanged.

The redacted relay envelope MUST preserve `companionId` as authenticated
routing metadata and `shardId` as optional provenance. The relay MUST NOT drop
the owner before fan-out. Raw parameters, prompts, task text, chain-of-thought,
filesystem paths, credentials, and unredacted tool results remain excluded.
The existing redacted title, scope, companion-authored reason, request time,
request expiry, status, and approval ID remain the request-card content.

Resolution MUST look up the queued record and revalidate its stored
`companionId` and optional `shardId`; possession of an approval ID is never
sufficient authority. The resolved event uses the attribution captured at
enqueue, never client-supplied attribution.

## Subscription And Fleet Scoping

The Companion UI subscribes to the approval event family through its existing
authenticated Hub/gateway connection. It MUST NOT open a browser-to-core or
browser-to-Garden approval channel.

For each browser session, the server derives the set of companion connections
the human may use from current fleet-session and attachment authority. A
browser-supplied companion list is not accepted. Every request snapshot,
streamed event, reconnect replay, and resolution is filtered server-side:

```text
event.companionId ∈ authenticated connected companion IDs
```

For a shard event, the server also verifies that `event.shardId` is presently
or historically bound to `event.companionId`. A shard under another parent is
not visible merely because its ID is known.

The existing telemetry-scope requirement still applies: no `approvals`
capability acknowledgement means no approval events, request cards, list
results, or decision controls. Fleet authority and the physical telemetry
ceiling are an intersection, never alternatives.

When the fleet session, contact binding, operator grant, attachment, parent
binding, or approval capability is revoked or changes, the server closes or
reauthorizes the stream before sending more events. The client clears
authority-bound shard and approval state. Reconnection performs the same
server-side filtering; cached cards do not confer resolution authority.

## Shard Visibility And Human Chat

The Companion UI presents shards as deployed entities nested beneath their
parent companion. The server supplies a bounded, redacted directory for the
currently authorized parent connection. A shard entry may contain:

- opaque `shardId`;
- server-resolved display label;
- lifecycle/availability state; and
- enough bounded task-purpose text to distinguish the deployment, subject to
  the normal redaction and cognition-intake policy.

It MUST NOT expose private reasoning, raw work logs, credentials, grant
tokens, unrestricted task context, or another parent's shards.

A human may select one of these server-listed shards and open a direct chat
thread. The selected `shardId` is a resource selector, not an authority claim.
On every send, attach, interrupt, reconnect, and history read, the server
revalidates:

```text
human session -> connected parent companion -> deployed shard
```

The server routes the turn to the shard's isolated chat/session ingress with
human and parent/shard provenance intact. It MUST NOT silently fall back to
the parent companion if the shard is unavailable, unknown, expired, or no
longer belongs to that parent.

Direct human-to-shard chat is an operator interaction path. It does not replace
ordinary shard-to-parent communication. Routine shard↔companion traffic,
including the shard telling its parent that work is blocked, continues through
ICP and its existing policy, intake, fatigue, and loop-safety gates. An
approval event is a separate control-plane signal and does not duplicate or
forge a chat message.

## Request Cards

A pending shard request renders as a contextual card above the active
conversation composer, consistent with the existing Companion UI approval
surface. The card identifies:

- the parent companion;
- the requesting shard label and opaque `shardId`;
- the redacted action title, scope, and reason;
- when the request was created and when the request expires;
- the offered grant mode: one request, or an explicitly bounded TTL when
  server policy offers one; and
- pending, approved, denied, expired, or blocked state.

The default approval is the exact pending request. The browser cannot invent a
TTL, broaden an action/scope, change a parent or shard, or convert a one-request
offer into a time-limited grant. If a TTL option is offered, its duration and
maximum scope are server-issued and displayed before the human decides.

Approve and deny actions use the authenticated Companion UI confirmation
resource. A stale, replayed, cross-parent, already resolved, or expired
decision fails closed. The card transitions only from a correlated server
result or resolved event; optimistic browser state is not authority.

The Garden confirmation queue remains an operator surface for the same
underlying queue. The Companion UI does not create a parallel approval store,
and a resolution from either authorized surface produces one terminal queue
outcome.

## Temporary Grant Semantics

Approval never changes a shard's standing capability tier, inherited tier,
denial mask, owner file, or deployed configuration. A gated capability such
as `world.control` remains absent from the shard's standing mask.

A shard approval may authorize one of two narrow modes:

### Request-scoped grant

This is the default and matches the existing queued-execution model.
Resolution authorizes the exact queued operation once. The grant is bound to:

- parent `companionId`;
- `shardId`;
- approval/request ID;
- method/action;
- normalized resource scope and reviewed parameters; and
- the authenticated shard workload generation or equivalent non-reusable
  identity.

The queue consumes the authorization while executing the stored operation.
There is no residual capability after success, failure, denial, or expiry, and
replay cannot execute it again.

### TTL-scoped grant

A TTL grant exists only when server policy explicitly offered it on the card
and the human selected that offered mode. It is bound to:

- the same parent and shard identity;
- the approved method/action;
- a scope no broader than the reviewed request;
- an absolute server-issued expiry; and
- a revocable grant identifier recorded in audit history.

Only matching requests from that exact live shard may consume the grant before
expiry. Parent-companion calls, sibling shards, replacement shard generations,
different methods, broader parameters, and requests after expiry are denied.
Clock uncertainty, missing grant state, inability to verify lineage, or
revocation-state failure denies use.

An implementation may persist an expiring grant record for restart safety, but
it MUST NOT persist tier widening or add the capability to the shard's standing
mask. If no authoritative recovery-safe grant store is available, restart
invalidates the TTL grant rather than reconstructing it from an approval event
or browser cache.

The shard's derived policy result remains authoritative. In particular, the
gateway MUST NOT auto-clear a shard fence merely because its parent companion
has an autonomous tier. The temporary grant is the only exception for the
approved request or TTL tuple.

## Audit And Redaction

Audit records for shard approvals include:

- parent `companionId`;
- `shardId`;
- approval ID and, for TTL mode, grant ID;
- redacted method/action and normalized scope;
- request, decision, execution/issuance, expiry, revocation, and replay
  outcomes; and
- authenticated human/device resolver provenance already required by the
  approval surface.

Audit and event payloads use allowlisted fields. They never include grant
secrets, raw tool parameters, private reasoning, full task context, or
credentials. The shard cannot publish or spoof `companion.approval.*` events;
those continue to originate at the gateway approval boundary.

## Non-Shard Compatibility

An approval without `shardId` is an ordinary companion approval:

- `companionId` is still the authenticated companion owner;
- the current ownerless refusal remains;
- capability-tier auto-clear behavior remains the companion's existing
  behavior;
- approve/deny and queued execution retain their current semantics;
- existing redaction and request-card content remain unchanged; and
- no shard directory, shard policy, or temporary TTL grant is inferred.

Implementations MUST include regression coverage proving that adding optional
shard provenance does not route ordinary requests through a shard path or
require shard metadata.

## Required Failure Cases

The implementation denies without enqueueing or executing when:

- a shard has no authenticated parent;
- the parent/shard binding is mismatched, stale, or ambiguous;
- an event or decision falls outside the human's connected companion set;
- the approvals telemetry/control capability is absent;
- a decision names only a leaked or guessed approval ID;
- a request or grant is expired, revoked, replayed, or already consumed;
- a TTL request widens the approved method, scope, parameters, or duration;
- a replacement or sibling shard attempts to use another shard's grant;
- tier, mask, grant, audit, or lineage state cannot be verified; or
- a direct-chat target is unavailable or no longer deployed under the parent.

No failure may fall back to global fleet visibility, parent execution, durable
tier widening, an ownerless queue entry, or a browser-trusted authority field.

## Implementation Seams And Acceptance Tests

The implementation should extend existing primitives at these seams:

- `src/boundary/gateway/approval-boundary.ts`: capture trusted parent/shard
  attribution, preserve ownerless refusal, and bind resolution/grants;
- `src/system/capabilities/confirmation-queue.ts` and
  `src/system/capabilities/approval-queue-port.ts`: carry immutable optional
  shard provenance and narrow grant metadata without changing ordinary
  entries;
- `src/shared/event-bus.ts`,
  `src/shared/contracts/companion-relay.ts`, and
  `src/channels/backplane/companion-relay/{redaction,relay}.ts`: retain the
  parent owner through redaction/fan-out and relay optional `shardId`;
- `src/channels/api/server/companion-relay-routes.ts`,
  `src/boundary/fleet-auth/companion-ui-action.ts`,
  `src/boundary/gateway/companion-ui-action-broker.ts`, and
  `src/channels/api/companion-ui-websocket.ts`: derive subscription and
  resolution scope from current server-side fleet authority;
- the canonical shard identity/deployment registry: prove parent binding,
  expose a redacted child directory, and validate direct-chat targets;
- `companion-ui/src/lib/protocol/*`, `companion-ui/src/lib/stream/*`, and
  `companion-ui/src/lib/approvals.ts`: strictly parse, store, filter, and
  correlate shard request/resolution events; and
- `companion-ui/src/ui/*`: render the nested shard selector, direct shard
  thread, and contextual request cards.

Acceptance coverage must prove:

1. ownerless and orphaned shard requests are refused before enqueue;
2. two parents with simultaneous shard requests cannot see or resolve each
   other's cards, including when an approval ID leaks;
3. shard provenance survives requested and resolved events and reconnect;
4. request-scoped approval executes only the exact queued operation once;
5. TTL approval authorizes only the exact parent/shard/action/scope tuple until
   expiry or revocation;
6. approval never changes the shard's standing tier or denial mask;
7. an autonomous parent does not auto-clear a shard-specific fence;
8. human direct chat reaches only the selected deployed shard under the
   connected parent and never falls back to the parent;
9. ordinary shard↔parent traffic continues over ICP; and
10. ordinary non-shard approvals keep their existing event, queue, resolution,
    redaction, and auto-clear behavior.
