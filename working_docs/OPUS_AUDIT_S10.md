# OPUS Codebase Audit — Sprint 10 (Location Data & World Control Surface)

- **Audit tree:** `origin/main` @ `bbef11c5` ("Merge PR #33 feat/multi-companion") — fetched and checked out fresh; local `main` was 145 commits stale.
- **Date:** 2026-07-08
- **Method:** 8 parallel Opus audit agents, each scoped to a sprint-10 seam-cluster, every finding grounded in `file:line` + quoted code. Domains: SSRF/egress, capability/trust gating, satellite registry, telemetry ingest, session/self-model, Garden admin, contacts/identity, persistence/config.
- **Scope framing:** the audit targets the seams Sprint 10 builds on, through a security-and-privacy-first lens (the sprint's §5 posture is the dominant risk surface).

> ### Baseline correction — read this first
> `origin/main` **already contains most of the Sprint-10 machinery** the plan doc describes as "NEW". Confirmed as-built and wired on this tree: `places.json` + `places-registry.ts` + `loadPlacesRegistryConfig`, `assertSatellitePlaceBindings`, `TurnRecordLocation` (`placeId`/`satelliteId`), the `SensorCognitionBridge` + `IdentityClaimResolver` + `presence-note-delivery` (D1/D2b/D3), the `situated-presence`/`situated-location` producers + self-model `situated` bucket (B1/B3), the `world` tool + `home_assistant` gateway method + `allowInternalNetwork` HA lane (C1/C2), the Garden `places-service`/`enrollment-service` (F1), and `world.read`/`world.control` tokens + staged-off control (C3/C4). **So this is an audit of shipped Sprint-10 code, not a pre-build baseline.** Several findings are bugs in already-merged S10 work.
>
> **Sprint-doc premises corrected against the code:**
> 1. "`message.routing.presence` has zero consumers" — **FALSE.** It is consumed by shards, situated-emanation, situated-location, situated-presence, turn-presence-mode, and pre-turn-state.
> 2. E1 "add `placeId`/`satelliteId` columns to TurnRecord via hasColumn ALTER" — **misscoped.** TurnRecords are schemaless JSONL (`sessions/turn-records.ts:460`), there is no `turn_records` SQL table, and location already round-trips. No migration work item exists; E1 verification is journal-forward-compat only.
> 3. C1's `home_assistant` methods, SSRF lane, and `allowInternalNetwork` are **already present** — C1's safety hinges on the pre-existing SSRF machinery audited below, not on new code.

---

## Summary

| Severity | Count |
|---|---|
| **Critical** | 2 |
| **High** | 9 |
| **Medium** | 20 |
| **Low** | 19 |
| **Total** | **54** |

*(Includes one Low, **U1**, added by the UBS static-analysis pass — see the [UBS section](#ubs-static-analysis-pass-v534) at the end. UBS otherwise corroborated existing findings and surfaced no new correctness bug.)*

**Bottom line:** the security *architecture* is sound and the core invariants hold (capabilities can only narrow, raw biometrics never reach core cognition, identity resolution of biometric claims is genuinely fail-closed, DNS-rebinding is closed, the HA token is gateway-isolated, `robotics`/`world.control` are correctly staged-off). The findings are concentrated in **five recurring weaknesses** that cut across clusters. Fixing the five themes closes most of the list.

---

## Cross-cutting themes (ranked by leverage)

### T1 — Hand-rolled config parsers silently accept unknown keys → privacy fail-open *(anti-Replika-guarantee hole)*
`parsePlaceConfig` (`places-registry.ts:164-210`) and `parseEndpointConfig`/`parseSatelliteConfig` (`satellite-registry.ts:362-437`) validate *known* keys but never **reject unknown** ones. A misspelled key like `"privicy": "private"` never reaches the value-validator, `value.privacy` is `undefined`, and the room silently parses as **`public`** — directly contradicting the code's own comment ("a typo can never silently demote a private room to public"). The same class silently drops `apiKeyPrincipalIds` (auth restriction vanishes), `placeId` (binding vanishes), `mirrorsPlaceId`, and `telemetryScopes`. **One shared "key set ⊆ known keys, else throw" helper across both registries closes 03-M2, 08-H1, 08-L3.** Highest leverage in the report.

### T2 — Unsanitized free-text flows verbatim into SYSTEM-attributed prompt text → prompt injection
Sensor/contact/config-derived strings reach the model with no neutralization: a hub-supplied contact `displayName` → `[SYSTEM: …]` context note (**05-C1, Critical**); `wrapPromptSectionXml` doesn't escape, so `place.displayName`/`description`/`presence.label`/`mindspaceLabel`/affordance names can break out of `<runtime_situated_presence>` (**05-H1**); a presence `label` is persisted into durable location and re-rendered every turn (**05-M1**); satellite `displayName` interpolated into `<runtime_satellite_endpoint>` (**03-L1**); self-asserted channel names into prompts (**07-M1/M4**). **A single shared `sanitizePromptEmbeddedText()` (collapse newlines, strip `[]`/`<>`, length-cap) used by every context-note and section producer closes the cluster.**

### T3 — Weak satellite/endpoint authentication → identity & place spoofing, forged presence
The satellite `mtls` mode is **auth theater** — it string-compares client-cert values read from request *headers* against the registry and never touches the real TLS peer cert, with nothing stripping those inbound headers (**03-C1, Critical**). A single shared gateway `API_KEY` collapses every `api_key`-mode endpoint to one principal, so `apiKeyPrincipalIds` cannot isolate satellites and a key-holder can swap `X-PSFN-Satellite-*` headers to impersonate any endpoint's `defaultIdentity` + `placeId` (**03-H1**). Telemetry ingest reads satellite/place origin from the *payload*, not an authenticated identity, so a key-holder forges presence for any place and injects notes into any session (**04-M1**). The `canonicalContactId` routing hint is a trusted-only-by-convention identity override (**07-M2**). **Sprint 10 treats `placeId`/identity-on-turn as authoritative; that trust is only as strong as this (currently spoofable) layer.**

### T4 — Trust and capability defaults resolve *up*, not *down*
Convention is "fail closed / resolve DOWN"; several defaults do the opposite. Unknown speakers auto-provision at `regular` trust, which unlocks `personal`-sensitivity disclosure (**07-H1**); `resolveChannelIdentity` never returns "unrecognized" — it mints a contact for any handle (**07-H2**); an unknown stored trust value decodes to `regular` (**07-L2**); a tool with no requirement-resolver entry runs **ungated** at every tier (**02-M2**); auth helpers `return true` when the token is unset (**06-L3**). Individually low-to-high; collectively they mean ambiguity currently grants rather than denies.

### T5 — Biometric containment is enforced at one consumer, not the ingest boundary
Core cognition is clean (bridge whitelists `hubIdentityId`+`confidence` only, fail-closed). But the HTTP ingest schema accepts arbitrary `payload` (`additionalProperties:true`) with no screening, and the Garden telemetry WebSocket forwards the full event **verbatim** — so a raw biometric blob rides ingest→bus→Garden admin clients, bypassing the bridge (**04-H1**). The bridge's own filter is a depth-4 **denylist**, not a fail-closed whitelist (**04-M3**). **Reject biometric-shaped/oversized payloads at `ingestTelemetryPayload` before emit** — the sprint's D2b "core must reject raw biometric payload" belongs at the door.

**Secondary theme — template hygiene before F1 clones:** F1's scaffolds (`api-routes-rooms.ts`, `api-routes-enrollment.ts`) already carry raw-error-message leakage (**06-M1**) and a client-supplied, spoofable audit actor on the biometric-linkage trail (**06-M2**). Fix the templates before the sprint copies them.

---

## Critical findings

### C1 — Satellite `mtls` auth is header-trust only; any API-key holder impersonates any satellite endpoint/identity
- **Location:** `src/channels/backplane/satellite-registry.ts:788-834` (`verifyMtlsAuth`); header ingestion `src/app/gateway/api-surface.ts:105-108`; config-pull `src/channels/api/server.ts:338-358`.
- **Issue:** `mtls` mode "verifies" a client cert by string-comparing `X-PSFN-Client-Cert-Fingerprint-SHA256`/`-SPKI-SHA256`/`-Subject`/`-SAN` **request headers** against the registry. It never consults `tlsSocket.getPeerCertificate()` (used for Garden/gateway transports, not here). No code strips those inbound headers; there is no documented trusted-proxy-strips contract. A SHA-256 fingerprint is **not a secret** (derivable from any handshake or the cert). Combined with the shared `API_KEY` (H1), a key-holder sets the satellite/endpoint/claim headers + the public fingerprint for a *different* mtls endpoint and passes verification, assuming its `defaultIdentity` (`authorId`, `canonicalContactId`, `channelPrivacy`) and `placeId`/location.
- **Root cause:** Authenticates a *claimed* cert identity (spoofable header of a non-secret) rather than a *proven* one (terminated TLS peer cert). `certBound:true` (03-L2) then overstates the guarantee.
- **Fix:** Bind mtls to the real terminated peer cert (`req.socket.getPeerCertificate()`), OR make the proxy trust boundary explicit and fail-closed: require a configured trusted-proxy secret/listener flag before honoring any `X-PSFN-Client-Cert-*` header, and unconditionally strip those headers on any non-trusted-proxy listener.
- **Sprint-10 relevance:** A2 pins `placeId` + identity onto the turn via this exact path; a spoofable binding lets an attacker pin a turn to an arbitrary room and to another satellite's contact identity. The auth trust boundary lives here (`places.json` is a soft registry) — fix before location/identity is treated as authoritative.

### C2 — Contact/config-derived presence-note text flows verbatim into a SYSTEM-attributed context note (prompt injection)
- **Location:** `src/core/agent/perception/presence-note-delivery.ts:48-63,90-125`; sink `SessionManager.appendContextSystemNote` (`src/core/session/manager.ts:1049-1069`), rendered as `[SYSTEM: …]` context speech.
- **Issue:** The D3 deliverer interpolates `presence.displayName` (a known contact's name, bound from an external identity hub via `hubIdentityId` — `identity-claim-resolver.ts:173`) and `placeDisplayName` directly into note text with **zero** escaping, then appends them as `role:'system'`, `authorId:'system'` context-visible speech the model actually sees. A hub-supplied name containing newlines or `[SYSTEM: …]`/fake-directive framing is a direct injection into system-attributed prompt text.
- **Root cause:** The delivery module is "deliberately thin — pure composition + one append" and trusts upstream, but no upstream layer sanitizes a display name against prompt-frame injection.
- **Fix:** Sanitize embedded strings in `composeKnownArrivalNote`/`composeAnonymousPresenceNote`/`composeDepartureNote` (collapse whitespace, strip `[]`/`<>`, length-cap). Prefer a shared `sanitizePromptEmbeddedText()` (see T2) used by every context-note producer.
- **Sprint-10 relevance:** This *is* D3, and it meets the sprint's named Critical criterion exactly — a contact-derived string (ultimately from a face/identity hub) reaches SYSTEM-labeled prompt text unescaped.

---

## High findings

### H1 — IPv6 SSRF holes (`::` unspecified, `fc00::/7` ULA) not in `ALWAYS_BLOCKED_RANGES`
- **Location:** `src/boundary/gateway/url-policy.ts:8-29`.
- **Issue:** The block-lists are IPv4-centric. (a) `::` is in neither `PRIVATE_RANGES` nor `ALWAYS_BLOCKED_RANGES`, so in the default lane `http://[::]/` passes policy *and* the post-DNS check and connects to the all-zeros address (a loopback-equivalent the codebase already treats as unsafe in `http-policy.ts:119`). (b) IPv6 ULA `fc00::/7` is in `PRIVATE_RANGES` but **not** `ALWAYS_BLOCKED_RANGES`, so under `allowInternalNetwork:true` it is permitted — AWS IMDS is reachable at `[fd00:ec2::254]`, giving SSRF-to-metadata over IPv6.
- **Fix:** Add `::`/`::0` to both lists and `fc00::/7` (`/^f[cd]/i`) + IPv6 IMDS to `ALWAYS_BLOCKED_RANGES`; prefer a normalized CIDR classifier (`ipaddr.js`) over regexes.
- **Sprint-10 relevance:** C1 sets `allowInternalNetwork:true` (`home-assistant.ts:103`). The HA path is host-pinned, but the shared `ALWAYS_BLOCKED_RANGES` is the safety net for *every* internal lane (a pre-existing no-allowlist internal lane exists at `bootstrap-input.ts:279`). Fix before extending the internal-network surface.

### H2 — `requestText` buffers the entire response with no streaming byte cap (OOM DoS)
- **Location:** `src/boundary/gateway/methods/web.ts:357-395`.
- **Issue:** The body accumulates into an unbounded `chunks: Buffer[]`, size-checked only *after* full buffering. The pre-buffer guard is a `content-length` header check, trivially defeated by a chunked response or omitted `Content-Length`. A malicious/compromised endpoint streams gigabytes and OOMs the gateway; the HA 1 MB cap (`home-assistant.ts:189`) is post-buffer.
- **Fix:** Track cumulative bytes in the `data` handler against a hard cap and `req.destroy()` on exceed; do not trust `content-length`.
- **Sprint-10 relevance:** Pre-existing; C1 routes HA through this helper and adds no protection.

### H3 — Self-directed/heartbeat turns are trust-level `primary`, so the `world.control` requester-trust gate does not keep a human in the loop
- **Location:** `src/core/agent/substrate-agent/runtime-context.ts:777,794,805` → `turn-execution/pre-turn-state.ts:392` → `src/app/agent/main.ts:577`; enforced `src/boundary/integrations/world/tools.ts:285-293`.
- **Issue:** Gate 2 of `world.control` is "only primary/trusted (owner/partner) may drive effectors," reading `authorContext.trustLevel`. But every internal/self-directed turn is hard-coded to `trustLevel: 'primary'` (so memory/prompt scoping works), and `isHighTierTrustLevel('primary')` is true — so a heartbeat/autonomous turn with **no human requester** satisfies the gate.
- **Fix:** Distinguish requester *provenance* from trust — refuse control when `speakerRole === 'system'`/self-directed (already set on these paths), or carry an explicit `humanRequester: boolean` required by `runControl`. If autonomous actuation is intended, make it a separately-tokened decision.
- **Sprint-10 relevance:** On the C3/C4 surface. Masked today by `WORLD_CONTROL_RUNTIME_ENABLED=false` + `world.control` withheld from all tiers, but the moment those staged-off controls lift, an unattended heartbeat could actuate physical hardware — the exact outcome Gate 2 exists to prevent.

### H4 — Single shared `API_KEY` collapses all `api_key`-mode endpoints to one principal → cross-endpoint impersonation by header swap
- **Location:** `src/channels/api/http-policy.ts:468-494`, `src/channels/backplane/http/auth.ts:34-47`, `satellite-registry.ts:768-786`.
- **Issue:** Every bearer of the one key derives the same `principal.id = api-key-<sha256(key)[:24]>`. The only per-endpoint isolation `api_key` mode offers is `apiKeyPrincipalIds`, but with one key there is one principal, so the allow-list admits everyone-with-the-key or no-one. Any key-holder swaps `X-PSFN-Satellite-ID`/`-Endpoint-ID`/`-Claim-Type` and claims any registered endpoint's `defaultIdentity` + place binding — no cert needed. Compounds C1.
- **Fix:** Issue per-satellite credentials (distinct keys → distinct principal ids, or enforce the C1 peer-cert binding) and make `apiKeyPrincipalIds` meaningful; require properly-bound mtls for any endpoint whose `defaultIdentity` differs.
- **Sprint-10 relevance:** Same place/identity exposure as C1 without needing a cert; `places.json` binding is only as trustworthy as the weakest endpoint auth on the shared key.

### H5 — Raw biometric payloads pass the ingest boundary and are forwarded verbatim to Garden admin clients
- **Location:** `src/channels/api/server.ts:88-96,649-659`; `src/operator/garden/server-telemetry-transport.ts:64,74-85,100-122`.
- **Issue:** Ingest schema accepts arbitrary `payload` (`additionalProperties:true`, ≤1 MB) with no biometric/size screening; the only filter lives in the cognition bridge (a *separate* subscriber). The Garden telemetry WS sanitizer has no case for `external.telemetry.ingested` and returns it verbatim (`:121`), so a raw biometric blob rides ingest→bus→Garden admin WS in the clear, bypassing the bridge.
- **Fix:** Reject raw-biometric-shaped payloads (whitelist shape + cap size) at `ingestTelemetryPayload` **before** emit; also strip `payload` from the Garden-forwarded event (defense in depth).
- **Sprint-10 relevance:** D2b requires "core must reject any event carrying a raw biometric payload." Core cognition does; the *ingest boundary* does not, and Garden is a live leak path. Borderline Critical under the "biometrics never cross ingest" convention — held High only because it does not reach core cognition or companion-data at rest.

### H6 — `wrapPromptSectionXml` does not escape content → situated-presence/satellite blocks can break out of their section frame
- **Location:** `src/core/identity/prompt-sections.ts:42-47`; consumers `runtime-context-sections/situated-presence.ts:191-247`, `satellite.ts:20-34`.
- **Issue:** The wrapper only trims+wraps (`<tag>\n${content}\n</tag>`), no escaping. The situated block feeds it `place.displayName`/`description`, `presence.label`, `mindspaceLabel`, affordance names verbatim; a value with a newline + `</runtime_situated_presence>` or `[SYSTEM] …` injects arbitrary prompt structure.
- **Fix:** Neutralize `<`/`>`/section-tag sequences and control newlines in interpolated free-text before wrapping, or have `wrapPromptSectionXml` escape angle brackets in content while preserving wrapper tags. (Part of T2's shared sanitizer.)
- **Sprint-10 relevance:** B1's situated-presence producer is the first free-text consumer of the places registry + `routing.presence`; the unescaped path is new attack surface it introduced.

### H7 — Unknown/unauthenticated speakers auto-provisioned at `regular` trust, unlocking `personal`-sensitivity disclosure
- **Location:** `src/core/contacts/store/upsert-resolve-operations.ts:268-282`; trust ceiling `src/system/trust/runtime-policy.ts:9-12`; entity default `store/social-graph.ts:191`.
- **Issue:** A never-seen handle auto-creates a contact at `trustLevel: 'regular'` (not floor `public`). `trustCeiling.regular = ['public','personal']` and social-graph entities default to `'personal'` sensitivity, so a first-time unauthenticated speaker on a private channel immediately clears the trust half of the disclosure gate for `personal`-tier content (other contacts' names/relationships, `personal` memories) with no operator ack.
- **Fix:** Seed auto-provisioned/unrecognized identities at `public`; require explicit operator/tool assignment to raise to `regular`+. Keep `primary` auto-detect.
- **Sprint-10 relevance:** Exactly the E3/D2b disclosure boundary — a low-confidence/unbound identity must resolve to a low-trust "unrecognized" scope; today it resolves to a disclosing tier, which E3 `physicalLastSeen` notes would inherit.

### H8 — `resolveChannelIdentity` never fails closed; unsafe template for D2b hub-identity binding
- **Location:** `src/core/contacts/store/upsert-resolve-operations.ts:232-287`; per-turn default `runtime-context.ts:912-920`.
- **Issue:** Typed `: Contact` (never `undefined`); on a miss it unconditionally creates a contact. The default per-turn tracking mode is `'auto'`, so any unknown author becomes a persisted contact — fail-open by design. D2b requires the opposite: an unbound/low-confidence claim must yield a generic "unrecognized person" and persist nothing without owner enrollment.
- **Fix:** Do **not** route hub/biometric claims through `resolveChannelIdentity`. Add a resolve-only `resolveHubIdentity(): Contact | 'unbound' | 'low_confidence'` backed by the owner-only enrollment table. The existing verified-binding challenge flow (`store/identity-link-verification.ts`, nonce+signature+TTL) and the `approval` tracking mode (which does not auto-create) are the correct templates.
- **Sprint-10 relevance:** Core D2b requirement — fail closed on unbound/low-confidence, never a guessed identity. The existing channel-identity machinery does the reverse.

### H9 — Soft-registry parsers silently ignore unknown keys, defeating the stated fail-closed privacy invariant
- **Location:** `src/channels/backplane/places-registry.ts:164-210`; same pattern `satellite-registry.ts:362-437`.
- **Issue:** See **T1**. A misspelled `privacy` key → room parses as `public`, silently widening delivery, contradicting the code's own comment. Same class silently drops `mirrorsPlaceId`, `apiKeyPrincipalIds`, `placeId`, `telemetryScopes`.
- **Fix:** After extracting known fields, assert `Object.keys(value)` ⊆ recognized set and throw on extras — one helper reused across both registries.
- **Sprint-10 relevance:** `places.json` is the trust surface for latent-space vs physical delivery classification; a silently-dropped `privacy`/`mirrorsPlaceId` is a real anti-Replika-guarantee hole. Existing bug in shipped S10 code. *(This is the `places.json` instance of the same root cause as 03-M2; fix once, apply to both.)*

---

## Medium findings

| # | Finding | Location | Fix (short) |
|---|---|---|---|
| **01-M1** | Agent-supplied `Authorization`/`Cookie` headers replayed to every redirect hop (cross-origin credential leak in default lane) | `boundary/gateway/methods/web.ts:512-598` | Strip sensitive headers on origin-changing redirects |
| **01-M2** | Host allowlist ignores port — HA redirect to another port of the HA box still gets the Bearer token | `url-policy.ts:260-272`, `home-assistant.ts:100-106` | Match `host[:port]` for internal lanes |
| **01-M3** | `resolveOptionalEnvCredential` silently falls back to `process.env` when the vault is absent (silent fallback on a security path) | `boundary/custody/credential-vault.ts:307-316` | Require vault present for security-sensitive creds; fail closed |
| **02-M1** | Tool-surface drift enforced only by tests + a subset guard, not a runtime registration assertion | `tool-runtime-facade.ts:341`, `registry.ts:575-606` | Assert `isCanonicalFirstPartyToolName` in `registerTool` |
| **02-M2** | Systemic fail-open: a tool with no requirement resolver/annotation resolves to `[]` tokens → allowed at every tier | `system/capabilities/requirements.ts:332-352`, `eligibility.ts:131-133` | Require explicit resolver for boundary-domain tools; reject `[]` |
| **03-M1** | `channelId = satellite:${claimType}:${sessionId}` omits `satelliteId`/`endpointId` → cross-endpoint session (place/identity) collision | `satellite-registry.ts:931`, uniqueness `:439-464` | Key the room by resolved endpoint, or enforce global `claimType` uniqueness |
| **03-M2** | Config parsers silently ignore unknown fields (satellite registry instance of T1) | `satellite-registry.ts:362-437` | Unknown-key rejection (shared with H9) |
| **04-M1** | Satellite/place origin & note-target channel self-asserted from payload; shared key forges presence for any place/session | `http-policy.ts:472-505`, `sensor-cognition-bridge.ts:227-287` | Derive `satelliteId` from an authenticated per-satellite credential; validate `channelId` ∈ place scope |
| **04-M2** | No rate limiting on `/v1/telemetry/ingest`; nonce map grows unbounded within TTL | `channels/api/server.ts:601-695` | Per-source token bucket + LRU/size cap on nonce map |
| **04-M3** | Biometric detection is a depth-4 **denylist**, not a fail-closed whitelist (misses `faceVector`/`iris`/deep nesting) | `sensor-cognition-bridge.ts:28-43,204-215` | Strict whitelist at ingest (claim = `hubIdentityId`+`confidence` only) |
| **04-M4** | Perception+cognition run **synchronously** inside the awaited HTTP ingest request (DB latency on the external hot path; `202` misleading) | `sensor-ingest-port.ts:17-24`, `event-bus.ts:1061-1097`, `server.ts:679` | Enqueue + return `202`; run cognition on a worker lane |
| **05-M1** | Durable situated `label` persists an unsanitized `presence.label`, re-rendered every turn (amplifies T2) | `self-model/situated-location.ts:86-101`, `state.ts:934-945` | Apply shared sanitizer + length-cap in `normalizeSituatedLocation` |
| **06-M1** | Verbose error leakage — raw `error.message`/`String(error)` returned to clients, incl. the `api-routes-rooms.ts` template F1 copies | `api-routes-rooms.ts:32-34`, `routes/shared.ts:5-10`, `api-routes.ts:811,837,864,881` | Return static message to client; log detail server-side w/ correlation id. **Fix template before F1 clones** |
| **06-M2** | Enrollment audit actor (`enrolledBy`/`revokedBy`) is client-supplied verbatim → spoofable biometric-linkage trail | `api-routes-enrollment.ts:76-77,97` → `enrollment-service.ts:100-116` | Derive actor from authenticated principal; treat client `actor` as advisory label only |
| **06-M3** | Login + cookie token compares use `===` (not timing-safe) while the Bearer path uses `timingSafeEqual` | `operator-surface.ts:169`, `server-routes.ts:93`, `http/auth.ts:93` | Route all three through `isExpectedApiToken`/`timingSafeEqual` |
| **07-M1** | Unrecognized speakers surface their self-asserted channel name; no generic "unrecognized person" fallback | `runtime-context.ts:664-672,868-899` | For the biometric/hub path render a fixed "unrecognized person"; don't reuse `resolvePromptUserName` |
| **07-M2** | `canonicalContactId` routing hint overrides channel resolution and adopts the target's trust (trusted-by-convention only) | `runtime-context.ts:882-885,917-924` | Assert `routing.canonicalContactId` is server-set-only; hub binding resolves via its own owner-only table |
| **07-M3** | Related/selected contact display names emitted via ungated `getById`, relying entirely on upstream memory gating | `memory/retrieval/social-context.ts:123-151,310-335`; `store/social-graph.ts:206-230` | Independently trust-scope contact-PII emission |
| **07-M4** | Channel-supplied `displayName` overwrites a stored name when the existing one "looks opaque" (identity-labeling spoof) | `upsert-resolve-operations.ts:255-263`, `identity-utils.ts:158-165` | Route display-name changes through the audited mutation path |
| **08-M2** | No migration-version ledger; idempotency rests entirely on per-statement `IF NOT EXISTS` (one bare `ALTER` re-runs every boot) | `persistence/postgres.ts:99-140` | Add a ledger or a unit assertion that every migration string is idempotency-guarded |
| **08-M3** | Soft-registries bypass `verifyStartupOwnerFiles`; `assertSatellitePlaceBindings` is a per-entrypoint obligation, not a central gate | `system/config/startup-owner-files.ts:190-281` | Add both registry loads + the binding assertion to a central `verifyStartupRegistries` |

> *Note: 08-M1 ("E1 framing is wrong — TurnRecord is schemaless JSONL, no ALTER needed") is a **scoping correction**, not a defect — folded into the Baseline Correction above.*

---

## Low findings

Grouped; each is polish / defense-in-depth / latent-hazard, not a live exploit.

- **01-L1** HA `hostAllowlist` uses bracketed IPv6 literal `[::1]` but compares against unbracketed `::1` → IPv6-literal HA host always denied (fails *closed*, functional bug). — `home-assistant.ts:100-106`
- **01-L2** `PRIVATE_RANGES` omits CGNAT `100.64.0.0/10` (Tailscale). — `url-policy.ts:8-21`
- **02-L1** `world` unclassified in `TOOL_REVERSIBILITY_BY_NAME` → effector control defaults to "reversible" (metadata only, no gate keys off it). — `safeguards.ts:20-59`
- **02-L2** `getGrantedTokens()` returns the live granted-token `Set` by reference (cast-away-readonly foot-gun for `world.control`). — `capabilities/runtime.ts:45-48`
- **03-L1** Satellite `displayName` (no charset restriction) interpolated verbatim into `<runtime_satellite_endpoint>` (operator-controlled today; part of T2). — `satellite-registry.ts:367,415` → `satellite.ts:24`
- **03-L2** `certBound: mode==='mtls'` reports a guarantee never enforced (see C1); overstates to downstream consumers. — `satellite-registry.ts:757,924`
- **05-L1** Snapshot-hash canonical form changed (added `situated`) but ref tag stays `internal-state-v1` (latent; refs stored/compared opaquely, no functional break today). — `self-model/state.ts:321-329`
- **05-L2** `normalizeInternalState` silently tolerates a non-record `situated` bucket (every other bucket is `isRecord`-guarded). — `state.ts:875,926-930`
- **05-L3** *(informational, positive)* Presence-note channel scope verified **correct** (no cross-channel leak; fails closed on missing origin `channelId`) — but the drop is silent; add a telemetry counter. — `presence-note-delivery.ts:88,104`
- **06-L1** "OWNER-ONLY" == admin-token-holder; no owner-vs-lesser role or step-up on the biometric-linkage surface (single-owner by design; comment overstates). — `api-routes-enrollment.ts:9`
- **06-L2** Cross-companion isolation relies on distinct per-companion tokens; no per-companion token provisioning found (a shared `ADMIN_TOKEN` would let operator-A auth to companion-B's Garden). — `transport-paths.ts:72-78`
- **06-L3** Auth helpers `return true` when `token` is falsy (fail-open shape; safe today only because startup refuses a tokenless boot off loopback). — `server-auth.ts:11,21,36`
- **07-L1** `getByChannelIdentity` performs a write (legacy-Discord identity link) during a lookup — read with a side effect; the D2b resolve-only path must be strictly side-effect-free. — `contacts/store/read-operations.ts:54-66`
- **07-L2** Stored-enum decoders coerce unknown values to a default; `normalizeTrustLevel` → `'regular'` (disclosing) is a silent fallback on a security field (reinforces H7). — `identity-utils.ts:89-99,193-203`
- **08-L1** Satellite registry atomic write uses a fixed `${filePath}.tmp` and no `fsync` (concurrent-writer collision / power-loss short write); F1's places write path should not copy it. — `satellite-registry.ts:542-554`
- **08-L2** `enabled === undefined ? true` makes a present-but-minimal `satellites.json` silently enabled (absent-file path correctly returns `enabled:false`). — `satellite-registry.ts:476-486`
- **08-L3** `parsePlacePrivacy` returns `undefined` for absent, pushing the "absent means public" default onto every consumer (latent coupling; normalize to explicit `'public'` at parse time). — `places-registry.ts:72-79`
- **08-L4** *(reassurance, no defect)* E2 memory JSON-tag writes are injection-safe — `JSON.stringify` + parameterized `$N` binds; `placeId` shape-validated upstream. E2 green-lit from the injection/schema angle. — `memory/postgres-store/rows.ts:193-196`

---

## Positives verified (defenses that hold — do not regress in Sprint 10)

- **Capabilities can only narrow, never escalate.** `resolveEffectiveCapabilities` throws on any advertised cap outside `registryMax`; empty advertised → registry max. `robotics` is intersected out of the runtime-enabled set and is structurally unreachable — the C4 staged-off pattern is real. (`satellite-registry.ts:648-670`)
- **The capability gate wraps every registered tool**, `resolveWorldRequirement` is total (unknown action → requires both tokens → denied), no default tier grants `world.control`, and `WORLD_CONTROL_RUNTIME_ENABLED=false` refuses control fail-closed. (`substrate-agent.ts:624`, `requirements.ts:228-232`, `tiers.ts:11-63`, `tools.ts:68`)
- **Raw biometrics never reach core cognition**; identity-claim resolution is genuinely fail-closed (unenrolled/low-confidence/deleted → explicit `anonymous`, never a guessed name). (`identity-claim-resolver.ts:138-178`)
- **DNS rebinding is closed** (socket pinned to the vetted IP), **redirects are fully re-validated per hop** under the same lane policy, **IPv4 metadata stays blocked even under `allowInternalNetwork`**, DNS failures fail closed. (`web.ts:325-356,440-469,531-542`)
- **The HA token is gateway-isolated** — resolved from the vault, injected only as the outbound `Authorization` header, redacted from all error paths, and absent from the provider/agent credential env; HA fails closed when unconfigured. (`credential-vault.ts:358-371`, `home-assistant.ts:108-117`)
- **Telemetry ingest is auth-gated fail-closed** (503 without API key), nonce replay rejected, timestamp skew bounded, and the event bus does not let one throwing consumer crash it or others (`Promise.allSettled` + logged rejections, no silent swallow). (`http-policy.ts:496-505`, `server.ts:624-647`, `event-bus.ts:1078-1096`)
- **Satellite→place bindings are static registry values**, never taken from a request header, and the agent vs gateway load paths are in parity (both `loadSatelliteRegistryConfig` + `assertSatellitePlaceBindings`). (`satellite-registry.ts:917-918`, `gateway/main.ts:86-88`, `agent/startup-context.ts:144-146`)
- **Presence-note delivery routes by the telemetry origin's place-session `channelId`** (no cross-channel leak) and fails closed on a missing `channelId`. (`presence-note-delivery.ts:88`)
- **Contact identity resolution is exact-match only** (no fuzzy/confidence upgrade), identity-link conflicts are non-clobbering, and the verified-binding challenge flow (nonce+signature+TTL) is a sound template for owner-only hub binding. (`store/upsert.ts:95-97`, `store/identity-link-verification.ts`)
- **Garden startup fails closed** (tokenless boot refused off loopback), CSRF is defended (`SameSite=Strict; HttpOnly` cookie), body size bounded (64 KB), telemetry WS upgrade authenticated, multi-companion isolation is by process (no in-process IDOR). Enrollment view exposes **no** biometric field and applies `Cache-Control: no-store`.
- **Runtime persistence is Postgres-only** (SQLite survives only as a parity/test reference); the current migration chain is clean (`IF NOT EXISTS`/guarded `DO $$`); E2 JSON-tag writes are parameterized and injection-safe.

---

## Recommended pre-Sprint-10 actions (suggested bead candidates)

Ordered by leverage. These map onto the five themes; several are single shared-helper fixes that resolve multiple findings.

1. **[Critical] Fix satellite `mtls` to bind the real TLS peer cert** (or fail-closed proxy-strip contract) + **issue per-satellite credentials** so `apiKeyPrincipalIds` is meaningful. Closes C1, H4, 04-M1; unblocks trustworthy A2 place/identity binding. Correct `certBound` (03-L2).
2. **[Critical] Add `sanitizePromptEmbeddedText()`** and route every context-note + prompt-section producer through it; make `wrapPromptSectionXml` escape content. Closes C2, H6, 05-M1, 03-L1, 07-M1.
3. **[High] Unknown-key rejection helper** shared by `places-registry` + `satellite-registry`. Closes H9, 03-M2, 08-L3; the highest-leverage single change for the privacy guarantee.
4. **[High] Reject raw-biometric/oversized payloads at the ingest boundary** (whitelist shape) + strip `payload` from Garden-forwarded telemetry. Closes H5, 04-M3.
5. **[High] Gate `world.control` on requester provenance, not the `primary` label** — refuse self-directed/heartbeat actuation. Closes H3 before C3/C4 lifts staged-off control.
6. **[High] Seed unknown identities at `public`, not `regular`** + add a fail-closed `resolveHubIdentity()` resolve-only path for D2b (do not reuse `resolveChannelIdentity`). Closes H7, H8, 07-L2.
7. **[High] Extend `ALWAYS_BLOCKED_RANGES` for IPv6** (`::`, `fc00::/7`, IPv6 IMDS) and add a streaming byte cap to `requestText`. Closes H1, H2 before the internal HA lane widens.
8. **[Medium] Fix the F1 templates before cloning** — static error messages (06-M1) + principal-derived audit actor (06-M2); add per-source ingest rate limiting (04-M2) and decouple ingest from cognition (04-M4); central `verifyStartupRegistries` + binding assertion (08-M3); migration idempotency lint (08-M2).

---

## UBS static-analysis pass (v5.3.4)

A mechanical scan (UBS Ultimate Bug Scanner v5.3.4, AST-grep engine) was run over the **same 52 seam files** to catch what compiles-but-crashes — null derefs, missing `await`, resource leaks, timing/security patterns — that the semantic agents might have missed.

**Raw output:** 58 "critical", 153 "warning", 2751 "info" category-hits across the 52 files. As expected for UBS, the raw counts are **dominated by false positives** (the 2751 "info" is almost entirely `process.env.<NAME>` literals; the "criticals" are pattern matches on any `===`/`!==` in a file whose scope mentions "token", and on env-var *name* constants). After triage, **UBS surfaced no new confirmed correctness bug** beyond the semantic audit — but it independently **corroborated** two findings and added one Low.

### Corroborations (independent tool confirms the audit)
- **Timing-unsafe secret/token comparison → confirms [06-M3].** UBS flagged 38 `==`/`!=` "token compare" sites; after filtering the noise (type/enum checks like `typeof value !== 'string'`, `entry.type === normalized`), the genuine one is `operator-surface.ts:169` (`token === this.config.token`) — exactly 06-M3. Independent confirmation reinforces the recommendation to route **all** bearer/cookie/HMAC/reset-secret compares through `crypto.timingSafeEqual`.
- **Unstripped inbound client-cert headers → confirms [C1].** UBS flagged `buildSatelliteClaimHeaders` (`api-surface.ts:86-90`) under "request-derived object merge." The prototype-pollution framing is a false positive (Node header keys are own string properties; there is no `__proto__` merge sink), **but the flagged line is direct evidence for C1**: `const headers = { ...request.headers };` spreads *all* inbound headers through before overlaying named keys, so the spoofable `X-PSFN-Client-Cert-*` headers pass straight through with nothing stripping them — precisely the C1 gap.

### New finding
- **U1 (Low) — Host header used to build the request base URL.** `src/channels/api/server.ts:282` — `const url = new URL(req.url ?? '/', \`http://${req.headers.host ?? 'localhost'}\`)`. The parsed `url` (whose `.host`/`.origin` derive from the attacker-controllable `Host` header) flows into `handleSatelliteConfigPull(req, res, url, principal)`. Impact is **low** today — only `url.pathname`/`url.searchParams` are consumed (host-independent, used for routing) — but it is a latent host-header-poisoning pattern: any future consumer that reads `.host`/`.origin` off this URL to build a link/redirect would be poisonable. *Fix:* parse against a fixed placeholder origin (`http://internal`) since only path/query are used, or validate `Host` against a configured canonical origin. (UBS also flags this class at `server.ts:274,280` — same handler, same root.)

### Triaged false positives (recorded so the next reviewer doesn't re-chase them)
- **Prototype pollution ×10** — FP. Sites are `req.headers[...]` reads (`isHtmxRequest`, `auth.ts:96-97`) and the named-key `copy()` in `buildSatelliteClaimHeaders`; no request-controlled key-spread reaches an object-merge sink. (The one line worth keeping is C1 evidence, above.)
- **Possible hardcoded secrets ×4** — FP. All are env-var **name** constants (`HOME_ASSISTANT_TOKEN_ENV = 'HOME_ASSISTANT_TOKEN'`, `CREDENTIAL_VAULT_BACKEND_ENV = 'CREDENTIAL_VAULT_BACKEND'`, `DEFAULT_LITELLM_API_KEY_ENV`), not literal secret values.
- **Switch cases may be missing break ×51** — FP. Verified every switch in the 4 seam files that contain one (`world/tools.ts`, `capabilities/eligibility.ts`, `contacts/store/identity-utils.ts`, `tool-runtime-facade.ts`): each case terminates with `return`/`throw`, and the flagged multi-line cases are intentional shared-label groups (`case 'verified': case 'failed': … return value`). No fallthrough bug.
- **Deep property access "high crash risk" ×33** — FP. `Object.prototype.hasOwnProperty.call(...)` and access on already-validated arrays (`satellite.capabilities.effective.join(...)`).
- **async EventEmitter listener not awaited ×1** — benign. `sensor-cognition-bridge.ts:512` registers an `async` handler on `eventBus.on('external.telemetry.ingested', …)`; cluster 04 verified the bus **awaits** every handler (`Promise.allSettled`, rejections logged — no silent swallow) and the bridge fails closed internally (`:521-538`). (This is the *other* side of finding **04-M4**: the bus awaiting cognition is a latency concern, not a lost-error one.)
- **Loose equality ×6 / non-null assertion ×6 / nullish-coalescing chains ×11 / `env-in-client` ×1** — FP/non-applicable (server-side code, no client bundle; assertions on validated values).
- **`fs.writeFileSync` not atomic ×1** — already captured as **08-L1** (satellite registry write uses a fixed temp path + no fsync).

**Net:** the mechanical pass adds confidence that the semantic audit did not miss a class of crash/leak bug on these seams, tightens two existing findings with a second independent signal, and contributes one Low (U1). The five cross-cutting themes and the Critical/High findings are unchanged.

---

*Generated by an 8-agent parallel Opus audit plus a UBS v5.3.4 static-analysis pass; every finding is anchored to `file:line` in the referenced source. Per-cluster raw findings are preserved in the session scratchpad (`audit-parts/01..08`); UBS raw output in `ubs-full.txt`/`ubs-findings.jsonl`. The audit worktree at `origin/main` is read-only and can be removed with `git worktree remove`.*
