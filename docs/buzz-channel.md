# Buzz gateway channel

Buzz is a gateway-owned companion channel installed through the generic
[channel plugin host](channel-plugins.md). The first supported slice connects a
single configured PSFN companion to explicitly allowlisted Buzz Stream rooms.

Buzz owns the Nostr relay, community membership, room, and event history. PSFN
owns the companion's cognition, canonical contacts, trust, memory, and
cross-channel continuity. The adapter does not create a second companion mind:
the `companionId` routes Buzz turns to the same core that can also have Discord,
Multica, or other channel adapters.

## Supported Stream flow

1. The gateway opens the configured relay WebSocket and completes NIP-42
   authentication with the companion's Nostr key.
2. It subscribes only to kind `9` events in the configured `h`-tagged rooms
   that `p`-tag the companion pubkey. The initial subscription starts at gateway
   startup; durable replay is not part of this slice.
3. Before a turn reaches the model, the adapter verifies the Nostr signature,
   exact room, exact author pubkey, companion mention, top-level shape, and
   self-author exclusion. The body and transport-authenticated group addressing
   then pass through CogSec intake.
4. The gateway routes one deterministic `channelType: "buzz"` message to the
   configured companion. The normalized relay origin remains part of channel
   and author identity so two Buzz communities cannot collide.
5. A successful response becomes one signed kind `9` event in the same room.
   Its `e` tag is a direct NIP-10 reply to the trigger, and its `p` tag names the
   triggering author. The relay must acknowledge the publication within the
   gateway's configured channel shutdown timeout.

Authentication rejection, connection failure, unexpected connection loss, and
publish rejection are bounded and visible through the channel operator-alert
path. Secret key material is never placed in the owner file, message, log, or
exception.

## Configuration

The system-owned `channels.json` file holds routing, bootstrap allowlists, and
an environment credential reference. The key itself remains in the gateway
environment.

```json
{
  "buzz": {
    "enabled": true,
    "relayUrl": "wss://relay.example.test",
    "companionId": "11111111-1111-4111-8111-111111111111",
    "privateKeyRef": {
      "kind": "env",
      "envName": "BUZZ_COMPANION_NSEC"
    },
    "channelIds": [
      "22222222-2222-4222-8222-222222222222"
    ],
    "allowedAuthorPubkeys": [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ]
  }
}
```

`relayUrl` must be an origin with no credentials, path, query, or fragment.
Remote relays require `wss://`; plain `ws://` is accepted only for loopback
development relays. Channel IDs must be lowercase RFC-4122 UUIDs, and author
identities must be exact 64-character lowercase hex pubkeys. Duplicate or
unknown values reject. The referenced private key may be a 32-byte lowercase
hex value or an `nsec` value. Gateway startup fails closed when the reference is
missing or the resolved key is invalid.

## Current boundary

This tracer supports allowlisted top-level Stream mentions and anchored replies.
It does not yet consume relay membership changes, reconnect or persist replay
cursors, ingest nested thread turns, resolve Buzz profiles to canonical
contacts, publish Forum events, or handle direct messages. In particular, a
Buzz display name or NIP-05 label is presentation only and never grants trust,
memory access, or work authority.

Do not use the current Stream bootstrap allowlist as proof that an author is a
human, a sibling companion, or authorized to issue Multica work. Those bindings
belong to the later canonical-contact and action-authority layers.

For a disposable end-to-end check against an already running local relay, run:

```bash
BUZZ_LIVE_RELAY_URL=ws://127.0.0.1:3100 npm run smoke:buzz-channel
```

The smoke creates ephemeral identities and an open Stream room, proves one
signed mention and anchored response through the adapter, and then deletes the
room. It never reads or writes deployment credentials.
