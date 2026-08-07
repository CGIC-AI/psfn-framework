# Channels — External Surfaces, Backplane & Transport

> **Working draft** in `working_docs/docs-gap/channels.md` — promote to `docs/channels.md` after review.
> **System:** `channels` (`system:channels`) · **Code:** `src/channels/{api,backplane,discord,telegram,shared}` + `src/app/gateway/main.ts` + `src/app/startup/composition/channel-runtime.ts`
> **Tracker:** `working_docs/docs-gap/TRACKER.md` #2 · **Status:** draft from code @ 2026-08-06

## Orientation

Channels are every way a human reaches the companion: the OpenAI-compatible HTTP API, Discord, and Telegram. **Wyoming** is a *voice protocol*, not a `channels/` adapter — it is routed at the gateway boundary (`src/boundary/gateway/wyoming-routing.ts`) and its transport is documented in `voice.md`. The **companion relay** (`src/channels/backplane/companion-relay/`) is the *outbound* surface: the companion runtime pushes redacted operational events (tool activity, emotion snapshots, approval requests, artifact previews) to the Satellite Hub over an authenticated SSE stream and receives approval decisions back (bead w9hj.1) — it is not an inbound chat channel. The **Gateway** (`src/app/gateway/main.ts`) owns the privileged edge — secrets, outbound network, SSRF checks, confirmation queues, and the public `/v1` listener — while the **Agent** (`src/app/agent/main.ts`) owns the conversational core. Adapters run gateway-side; the agent never holds provider tokens. The backplane (`src/channels/backplane/`) is the registry that binds a place/channel to its privacy envelope, group-memory config, and satellite/companion identity.

**Who it's for:** contributors adding a provider or a new external surface, operators wiring `channels.json`, and reviewers auditing attribution and privacy boundaries.

**Fits between:** `architecture.md` (Gateway vs Agent split) → `chat-turn-lifecycle.md` (inbound delivery) → here (adapter + backplane) → `cognitive-security.md` (intake firewall on every inbound).

## Mental model

```
Telegram/Discord           ─┐
Satellite Hub (mTLS)       —┤  (companion relay = outbound SSE egress, w9hj.1)
OpenAI /v1 API             ─┼─► Gateway — ChannelGatewayAdapter
                              (Wyoming voice is gateway-routed; see voice.md)
                              ├─ backplane (places-registry, satellite-registry, safe-remote-fetch)
                              ├─ auth (bearer / cookie / mTLS client-cert, src/channels/backplane/http/)
                              ├─ http-policy (CORS, header clamp, SSRF)
                              └─ JSON-RPC over Unix socket ─► Agent: SubstrateAgent + SessionManager
                                                                └─► ChannelAdapterPort / OutboundContext
```

A **Place** is a channel + channel-scoped identity (guild/channel ID, Telegram chat ID). A **Satellite** is a device/app endpoint authenticated by mTLS client cert. An **Embodiment** is the form the companion is perceived through.

## Entry points

| Entry | Location | Purpose |
|-------|----------|---------|
| `ChannelGatewayAdapter` | `src/channels/backplane/types.ts` | Gateway-side adapter contract: `start()`, `send()`, `capabilities`, prompt adapter, outbound adapter |
| `ChannelAdapterPort` (agent-side) | `src/channels/backplane/types.ts` | Agent-side view of a channel for turn routing and `OutboundContext` |
| `places-registry.ts` | `src/channels/backplane/places-registry.ts` | CRUD for places; mermaid export via `places-mermaid.ts` |
| `satellite-registry.ts` | `src/channels/backplane/satellite-registry.ts` | mTLS client-cert → satellite identity (`deriveClientCertIdentity`, `src/channels/backplane/http/client-cert.ts`) |
| `safe-remote-fetch.ts` | `src/channels/backplane/safe-remote-fetch.ts` | SSRF-defended fetch for remote channel payloads |
| `config.ts` (`CHANNELS_FILE_NAME='channels.json'`) | `src/channels/backplane/config.ts:54` | Owner-file for all channels; Telegram mode polling/webhook, Discord token, API bearer, group-memory per-channel |
| `server.ts` | `src/channels/api/server.ts:1` | OpenAI-compatible HTTP (`GET /v1/models`, `POST /v1/chat/completions`, sensor ingest) — framework-free `node:http` |
| `discord/adapter.ts` | `src/channels/discord/adapter.ts` | Discord gateway adapter (reactions, attachments, clarification, voice) |
| `telegram/adapter.ts` | `src/channels/telegram/adapter.ts` | Telegram polling/webhook adapter (`pollIntervalMs=1000`, `webhook:{host,port,path}` `:56`) |
| `shared/reaction-surface.ts` | `src/channels/shared/reaction-surface.ts` | Emoji meanings by guild, shared reaction model |
| `CompanionEventRelay` | `src/channels/backplane/companion-relay/relay.ts` | **Outbound** SSE egress of redacted operational events to the Satellite Hub; approval decisions return via `POST /v1/companion/approvals/{id}` (bead w9hj.1). Contracts in `src/shared/contracts/companion-relay.ts` |
| Wyoming voice routing | `src/boundary/gateway/wyoming-routing.ts` | Voice protocol routed at the gateway boundary — **not** a `channels/` adapter; transport details in `voice.md` |

## Key types

| Type | Location | Purpose |
|------|----------|---------|
| `ChannelPrivacy` / `ChannelEnvelopeLabel` / `ChannelClassificationEpoch` | `src/system/trust/context-envelope.ts` | Privacy envelope per place (`open | semi_private | invite_only` after E3.2 re-key) |
| `ChannelGroupMemoryConfig` | `src/system/config/group-memory-config.ts` (via `backplane/config.ts:30`) | Per-channel extraction mode (`direct/group/auto`), salience gate, backfill controls |
| `TelegramChannelConfig` | `src/channels/backplane/config.ts:71` | `{enabled, token, allowedUsers, operatorChatId, mode, pollIntervalMs, webhook}` |
| `ChannelCapabilities` | `src/channels/backplane/types.ts` | Declares what a channel can do (reactions, voice, attachments) |
| `OutboundContext` | `src/channels/backplane/types.ts` | Channel + place + privacy + disclosure lineage for outbound gating |
| `ApiHealthSubsystem` | `src/channels/api/types.ts` | Health subsystem enum for `GET /health` watchdog checks |
| `ExternalChannelProfileConfig` | `src/channels/backplane/config.ts` | Multi-companion (sprint-10 W1): which `CompanionId` owns a channel account |
| `CustomEmojiMeaningsByGuild` | `src/channels/shared/reaction-surface.ts:33` | Guild-scoped emoji → meaning map |
| `TestingHarnessGardenAdminConfig` | `src/channels/backplane/testing-harness-garden-config.ts` | Test-harness Garden verifier/action allowlist |

## Data flow

### Inbound (external → agent)

1. Gateway adapter receives event (Telegram update, Discord gateway event, `POST /v1/chat/completions`).
2. `http-policy` + `safe-remote-fetch` apply CORS clamp, header clamp, and SSRF checks; `client-cert.ts:stripClientCertHeaders` + `deriveClientCertIdentity` bind satellite mTLS identity on the satellite listener.
3. Auth: `hasBearerToken` / `hasCookieValue` / `isExpectedApiToken` (`src/channels/backplane/http/auth.ts`); Telegram allows `allowedUsers` + `operatorChatId`.
4. Adapter normalizes to `ChannelAdapterPort` and forwards over Unix socket JSON-RPC to `SubstrateAgent`. CogSec intake firewall runs on every boundary-crossing payload (see `cognitive-security.md`).
5. `SessionManager` resolves/creates session keyed by `(companionId, channel, place)`; attribution prefix added per `attribution.md`.

### Outbound (agent → external)

1. Model produces reply → `OutboundContext` (place, privacy, disclosure lineage) checked against `ChannelPrivacy` and `ChannelCapabilities`.
2. Shard/analysis outbound and internal `internal:free-time:*` turns are blocked from external dispatch by `isInternalSessionId()` and share the same `post-turn-outbound-gates`.
3. `ChannelOutboundAdapter.send()` delivers; reactions use `reaction-surface`.

### Backplane registries

* **Places registry** — source of truth for channel→place→envelope label mapping; supports mermaid export for `docs/world-map.mmd`. Re-key `semi_private → invite_only` landed as E3.1 (`context-envelope.md`).
* **Satellite registry** — maps pinned `satellites.json` client-cert fingerprints to satellite IDs; `validateSatelliteApiKeys` + `deriveClientCertIdentity` fail closed on cert mismatch (`certificates.md`).
* **Channel config** — single `channels.json` under `DATA_DIR` / split roots, loaded via `loadRequiredJson` / `loadSeedJson` (`src/system/config/load-or-seed.ts`), never from env. Discord/Telegram tokens are `CredentialReference` (env or vault).

## External dependencies

| Dependency | Purpose | Critical |
|------------|---------|----------|
| PostgreSQL | Contacts, trust, channel-scoped memory (via `persistence/runtime-factory.ts`) | Yes |
| Discord API / Telegram Bot API | Channel transport | Per deployment |
| Private CA + `satellites.json` | mTLS for satellite backplane (`certificates.md`, `src/app/cert-manager/main.ts`) | For satellite hub |
| `channels.json` (owner file) | Single source of per-channel enable/privacy/memory config | Yes |
| Vault / env credential | Token custody (`boundary/custody/credential-vault.ts`) | Yes |

## Configuration

| Source | Priority | Example |
|--------|----------|---------|
| `channels.json` (in `DATA_DIR` or `COMPANION_DATA_DIR`) | Canonical | `{telegram:{enabled,token,allowedUsers,mode,webhook}, discord:{…}, api:{bearer}, groupMemory:{…}}` — validated by `config-validation.ts` |
| `satellites.json` + CA cert | Satellite pinning | `validateSatelliteApiKeys`, `client-cert.ts` |
| `context-envelope` owner files | Privacy | `ChannelPrivacy`, `ChannelEnvelopeLabel`, epoch |
| Env (tokens) | Bootstrap only | `TELEGRAM_BOT_TOKEN` etc. via `CredentialReference`; `.env` never holds policy |

Run `npm run verify:settings-contract` after any shape change; `config-validation.test.ts` is the gate.

## Test infrastructure

| Type | Location | Coverage |
|------|----------|----------|
| Unit | `backplane/config-validation.test.ts`, `places-registry.test.ts`, `safe-remote-fetch.test.ts`, `discord/adapter.test.ts` | Envelope re-key, SSRF block, place CRUD, adapter surface |
| Channel harnesses | `backplane/testing-harness-garden-config.ts`, `http/primitives.test.ts` | Auth, header clamp, sensor ingest |
| E2E | `e2e/` + `satellite-hub-kube.md` | Live Telegram/Discord → Gateway → Agent round-trip via `npm run e2e` |

## Pitfalls & gotchas

* **Don't store tokens in code or env-sprawl.** Use `channels.json` `CredentialReference` (env or vault). `setup.md` and `AGENTS.md` forbid ad-hoc shared roots or `SHARED_WORKSPACE_PATH`.
* **Speaker attribution is a text prefix, not provider metadata.** See `attribution.md` — never masquerade as another speaker; prefix is the portable contract.
* **Internal sessions never go external.** `isInternalSessionId()` (`internal:free-time:*`, `subagent:*`) is the outbound kill-switch; shard output rides `shard-parent-icp-ingress`.
* **SSRF is gateway-side.** Any `fetch` of untrusted URLs must go through `safe-remote-fetch.ts`; raw `fetch` is a security bug.
* **Privacy envelope is load-bearing.** Changing `open → invite_only` re-keys storage classification (E3.2). Run the migration path in `context-envelope.md`, not a manual edit.

## Cross-links

* `docs/attribution.md` (speaker prefix), `docs/context-envelope.md` (envelope labels), `docs/certificates.md` (satellite mTLS), `docs/garden-control-plane.md` (admin transport), `docs/cognitive-security.md` (intake on every inbound), `docs/world-map.mmd` (places visualization)

## Promotion notes

Move to `docs/channels.md`; add sidebar entry and link from `architecture.md` (Gateway Responsibilities) and `operations.md` (channel wiring). Verify with `npm run verify:repository-hygiene`.
