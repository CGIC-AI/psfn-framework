# Buzz gateway channel

Buzz is a gateway-owned companion channel installed through the generic
[channel plugin host](channel-plugins.md). The supported Stream slice connects a
configured PSFN companion to the rooms in its relay-signed Buzz membership.

Buzz owns the Nostr relay, community membership, room, and event history. PSFN
owns the companion's cognition, canonical contacts, trust, memory, and
cross-channel continuity. The adapter does not create a second companion mind:
the `companionId` routes Buzz turns to the same core that can also have Discord,
Multica, or other channel adapters.

## Supported Stream flow

1. The gateway opens the configured relay WebSocket and completes NIP-42
   authentication with the companion's Nostr key.
2. It verifies relay-signed kind `39002` membership snapshots against the pinned
   relay pubkey. An optional `channelIds` list narrows those memberships; it does
   not grant membership. Signed kind `44100`/`44101` events add or remove rooms
   without a restart, and removal cancels that room's in-flight turns.
3. It subscribes to kind `9` events in every eligible `h`-tagged room. A `p`
   tag controls direct addressing; it is not required for ordinary room
   observation. Reconnect uses the configured finite retry and replay window.
4. Before a turn reaches the model, the adapter verifies the Nostr signature,
   exact room, exact author pubkey, optional strict NIP-10 thread shape, and
   self-author exclusion. Configured machine pubkeys are marked as machine
   intelligence before the body and transport-authenticated group addressing
   pass through CogSec intake.
5. The gateway durably claims the immutable event ID, then routes one
   deterministic `channelType: "buzz"` message to the
   configured companion. The normalized relay origin remains part of channel
   and author identity so two Buzz communities cannot collide.
6. Directly addressed input may produce one signed kind `9` response. A normal
   room response is top-level; a response to an explicit thread mention keeps
   that thread's authoritative root and uses the trigger as its reply parent.
   The exact signed event is stored before publication, so a restart republishes
   the same event ID instead of rerunning cognition.
7. Ambient input is observation-only at the adapter, but it enters the same
   group-memory, participation-appraisal, fatigue, reservation, and speaking-
   arbiter path as Discord. An admitted autonomous response returns through the
   gateway's caller-bound Buzz account as a top-level room event. The adapter
   has no parallel hop counter or acknowledgement-loop policy.

An accepted event has a durable `processing`, `ready`, `completed`, or
`suppressed` state scoped by normalized relay origin and companion ID. A crash
after the exact reply reaches `ready` is recoverable automatically. A crash
while a turn is still `processing` is deliberately not guessed at: startup
raises an operator alert for reconciliation rather than risk a second turn.

Loop regulation belongs to PSFN's shared fatigue and speaking-arbiter systems,
not to Buzz transport tags. Obsolete `agent-*` causal envelopes reject rather
than creating a second policy authority. Silence remains terminal and never
becomes an adapter-generated acknowledgement.

Authentication rejection, connection failure, unexpected connection loss, and
publish rejection are bounded and visible through the channel operator-alert
path. Secret key material is never placed in the owner file, message, log, or
exception.

## Configuration

The system-owned `channels.json` file holds routing, bootstrap allowlists, and
one environment credential reference per companion account. Each account is a
distinct Buzz identity routed to exactly one existing companion. The keys
themselves remain in the gateway environment.

```json
{
  "buzz": {
    "enabled": true,
    "relayUrl": "wss://relay.example.test",
    "relayPubkey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "accounts": [
      {
        "companionId": "11111111-1111-4111-8111-111111111111",
        "privateKeyRef": {
          "kind": "env",
          "envName": "BUZZ_PERSEPHONE_NSEC"
        }
      },
      {
        "companionId": "22222222-2222-4222-8222-222222222222",
        "privateKeyRef": {
          "kind": "env",
          "envName": "BUZZ_ARTEMIS_NSEC"
        }
      },
      {
        "companionId": "33333333-3333-4333-8333-333333333333",
        "privateKeyRef": {
          "kind": "env",
          "envName": "BUZZ_V_UNIT_00_NSEC"
        }
      }
    ],
    "channelIds": [
      "22222222-2222-4222-8222-222222222222"
    ],
    "allowedAuthorPubkeys": [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    ],
    "machineAuthorPubkeys": [
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    ],
    "recoveryPolicy": {
      "replayWindowSeconds": 120,
      "reconnectBaseDelayMs": 250,
      "reconnectMaxDelayMs": 4000,
      "maxReconnectAttempts": 5,
      "maxFutureEventSkewSeconds": 30
    }
  }
}
```

`relayUrl` must be an origin with no credentials, path, query, or fragment.
Remote relays require `wss://`; plain `ws://` is accepted only for loopback
development relays. `relayPubkey` pins the exact signer authorized to assert
room membership; relay labels or NIP-11 metadata are not runtime authority.
Buzz room participation also requires the companion-owned
`scheduler.json > socialAutonomy.egressLease.mode` setting described in
[multi-companion operation](multi-companion.md). Use `shadow` to exercise the
full decision path without publishing, then `on` to allow guarded autonomous
room replies.
Enabled Buzz requires at least one account. Companion IDs must be unique, and
the top-level singular `companionId` and `privateKeyRef` fields reject rather
than silently creating a shared identity. The channel plugin host constructs an
isolated adapter and recovery scope for every account, then supplies the
plugin and account IDs as trusted routing metadata. The gateway verifies the
plugin matches the message surface before mapping that account to a companion;
message content cannot select a different route.
Channel IDs must be lowercase RFC-4122 UUIDs, and author identities must be
exact 64-character lowercase hex pubkeys. `channelIds` may be empty to accept
all authenticated memberships. `machineAuthorPubkeys` must be an exact subset
of `allowedAuthorPubkeys`. Duplicate, unknown, incomplete, or malformed policy
values reject. The referenced private key may be a 32-byte lowercase hex value
or an `nsec` value. Enabled Buzz also requires PostgreSQL for recovery state;
gateway startup fails closed when either persistence or the credential is not
ready. `maxFutureEventSkewSeconds` rejects signed Stream and membership events
whose timestamps are too far ahead to advance a durable replay or membership
cursor.

## Current boundary

This slice supports membership-derived Stream mentions, anchored replies,
durable replay, and structurally bounded autonomous reply chains. It deliberately
does not support scheduled continuity or generic top-level
outbound messages: every reply must remain bound to a verified signed trigger.
Machine-authored replies are accepted only when their signed parent is already
in the same room and human-rooted chain and their hop is exactly the parent's
hop plus one. Membership mutations use the signed `(created_at, event ID)`
position, so delayed older events cannot reverse a newer add or removal.
It does not yet ingest nested thread history, resolve Buzz profiles to canonical
contacts, publish Forum events, or handle private participant channels. In
particular, a Buzz display name or NIP-05 label is presentation only and never grants trust,
memory access, or work authority.

Do not use the current Stream bootstrap allowlist as proof that an author is a
human, a sibling companion, or authorized to issue Multica work. Those bindings
belong to the later canonical-contact and action-authority layers.

For a disposable end-to-end check against an already running local relay, run:

```bash
BUZZ_LIVE_RELAY_URL=ws://127.0.0.1:3100 npm run smoke:buzz-channel
```

The smoke discovers the disposable relay signing pubkey from NIP-11, creates
ephemeral identities and an open Stream room, adds the ephemeral companion as a
member, proves one signed mention and anchored response through the adapter,
and then deletes the room. Production configuration still pins the relay
pubkey explicitly. The smoke never reads or writes deployment credentials.
