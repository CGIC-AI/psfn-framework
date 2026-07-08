# Sprint 10 — Location Data & World Control Surface

Status: PLAN (implement nothing from this doc without claiming beads first)
Author: deep-reasoner planning pass, 2026-07-08
Convention baseline: fail closed, no silent fallbacks, no compat shims, config+schema+tests land in one change (see `CLAUDE.md`).

This plan is grounded in verified code seams. Line numbers drift; the file paths and symbol names are the durable anchors. Every load-bearing claim below was spot-checked against the tree on 2026-07-08.

---

## 1. Goal & Scenario

Give the companion **location awareness** and a **world control surface** across physical and virtual spaces.

The companion should be able to answer, at any moment:

- **WHERE am I?** — "I'm emanating into the living-room satellite"; "I'm in the bedroom zone in VR."
- **WHAT do I perceive here?** — mmwave presence, face detection ("it's my partner"), the mic/speaker on this device.
- **WHAT can I act on here?** — physical: living-room lights, the TV (via Home Assistant); virtual: objects in a VR/game space.

### Reference scenario (physical)

Home Assistant (HA) instance on the LAN + four satellite devices, one each in **bedroom, office, kitchen, living room**. The companion can control *anything* from *anywhere* (global HA control). But when it is **emanating into the living-room satellite**, the **local surface is foregrounded**: that room's perceivers (mmwave presence, face detection, mic) and that room's effectors (living-room lights, TV) are what the prompt highlights and what casual "turn the lights down" resolves against.

### Reference scenario (virtual)

A VR/game world is the analog of an HA "site." Zones within it are the analog of rooms. Virtual objects (a door, a lamp, an NPC prop) are the analog of HA entities. The same tool and the same situated-context machinery serve both; only the effector namespace and the transport differ.

---

## 2. Architecture Decision — the place/affordance model

### 2.1 Naming (deliberate, to avoid collisions)

Garden already has a **"rooms"** concept (`src/operator/garden/services/rooms-service.ts`, `api-routes-rooms.ts`) — but a Garden "room" is a **conversation channel / social audience** keyed by `channelId`, explicitly "DATA only, never routed into prompt content." **Do not reuse "room" for physical space.** The presence/wyoming layer already uses **`siteId`** for an installation grouping. We keep that and introduce one new level:

| Term | Meaning | Physical example | Virtual example | Status |
|---|---|---|---|---|
| **Site** | An installation grouping | The home / HA instance | The VR world | Exists (`siteId` in presence + wyoming routing) |
| **Place** | A named location within a site | Living room, kitchen | A VR zone/region | **NEW** |
| **Satellite** | An emanation endpoint device bound to a place | The living-room Wyoming box | A VR client seat | Exists (`satellites.json`) |
| **Affordance** | A perceivable or controllable entity available at a place | mmwave sensor; living-room lights; TV | virtual door/lamp/prop | **NEW** |
| **Presence** | Where the companion is *currently emanating* | active satellite | active VR seat | Exists (`active-emanation-state.ts`) |

An **affordance** is either a **perceiver** (sensor: mmwave, face, mic, camera) or an **effector** (actuator: light, TV, media player, virtual object). Physical affordances resolve to HA entities (`ha:<entity_id>`); virtual affordances resolve to VR object ids (`vr:<object_id>`). One namespaced vocabulary, two backends.

### 2.2 Registry topology — satellites.json stays the security spine; a new soft-registry owns places

Two of the three prior explorers pointed at "extend `satellites.json`"; one at "new file." **Resolution: keep them separate, bound by a foreign key.** Rationale:

- `satellites.json` is the **security authority** for what an external endpoint may *claim* — advertised capabilities can only *narrow* `maxCapabilities`, never grant (`resolveEffectiveCapabilities`, `src/shared/contracts/satellite-registry.ts`). Per-request claim resolution runs on the hot path. Folding HA entity IDs / area mappings into it couples device auth to home-automation config and bloats the claim object.
- Places + affordances are a **different concern and lifecycle** (where things are, what's controllable) and are not security-authoritative for device identity.

Decision: a **new soft-registry owner file `places.json`** following the exact pattern `satellites.json` already uses (`src/channels/backplane/satellite-registry.ts`: `parse<X>Config` validator + `load<X>Config(dataDir)` returning an EMPTY default when absent, `schemaVersion` for forward-compat, loaded in `src/app/agent/startup-context.ts` and `src/app/gateway/main.ts`). Satellites gain a **`placeId`** binding (either static via the existing `staticLocationLabel` upgraded to a typed `placeId`, or dynamic for mobile satellites).

`places.json` shape (sketch — finalize in Workstream A):

```jsonc
{
  "schemaVersion": 1,
  "sites": [
    { "siteId": "home", "displayName": "Home", "kind": "physical" }
  ],
  "places": [
    {
      "placeId": "living_room",
      "siteId": "home",
      "displayName": "Living Room",
      "kind": "physical",              // physical | virtual
      "haAreaId": "living_room",       // physical-only: HA area binding
      "affordances": [
        { "affordanceId": "lr_lights", "role": "effector", "kind": "light",
          "backend": "ha", "entityId": "light.living_room", "control": ["on","off","brightness"] },
        { "affordanceId": "lr_tv", "role": "effector", "kind": "media_player",
          "backend": "ha", "entityId": "media_player.living_room_tv", "control": ["on","off","source"] },
        { "affordanceId": "lr_presence", "role": "perceiver", "kind": "presence",
          "backend": "ha", "entityId": "binary_sensor.living_room_mmwave" },
        { "affordanceId": "lr_face", "role": "perceiver", "kind": "face", "backend": "satellite" }
      ]
    }
  ]
}
```

Why soft-registry (loaded-if-present, no boot gate) not strict owner file: parity with `satellites.json`, and because an empty/absent `places.json` should degrade to "no world surface" — not fail boot. (If the operator later wants boot-time validation, the strict path in `src/system/config/startup-owner-files.ts` is available; noted as Open Question 1.)

### 2.3 Global vs situated affordances — the foregrounding rule

- The **`world` tool** (Workstream C) can address **any affordance in the site** by `affordanceId` — global control ("turn off the bedroom light while I'm in the office").
- The **situated-context prompt block** (Workstream B) foregrounds only the **current place's** affordances, derived from `routing.presence` / the active emanation → the satellite's `placeId` → that place's affordance list. This is what makes casual, deictic control ("dim the lights", "what's on the TV") resolve **locally by default**.
- Ambiguity resolution: a bare "the lights" resolves to the situated place's `light` affordances; a named place ("kitchen lights") resolves globally. The tool takes an optional explicit `placeId`/`affordanceId`; the situated block supplies the implicit default.

This directly implements the operator's ask: *control everything from anywhere, but the local surface is foregrounded when emanating into a room.*

---

## 3. Workstreams

Each task lists concrete files and acceptance criteria. Tasks marked **[MVP]** are the minimum coherent slice; **[STG]** is stretch.

### Workstream A — Place/affordance model + registry

**A1 [MVP] `places.json` soft-registry contract + loader.**
- New `src/shared/contracts/places-registry.ts` — `PlacesRegistryConfig`, `PlaceConfig`, `AffordanceConfig`, `AffordanceRole = 'perceiver' | 'effector'`, `AffordanceBackend = 'ha' | 'satellite' | 'vr'`, plus a frozen `AFFORDANCE_KINDS` allowlist (`light`, `media_player`, `switch`, `climate`, `presence`, `face`, `mic`, `camera`, `virtual_object`).
- New `src/channels/backplane/places-registry.ts` — `parsePlacesRegistryConfig(raw, label)` (hand-rolled validation, fail-closed on unknown fields — mirror `satellite-registry.ts`), `loadPlacesRegistryConfig(dataDir)` returning `EMPTY_PLACES_REGISTRY` when the file is absent, `resolvePlaceById`, `resolveAffordancesForPlace`, uniqueness assertions (`placeId`, `placeId:affordanceId`).
- Seed `config/places.seed.json` with the 4-room reference scenario (light-only + presence) so tests and Garden have live data.
- Loaded in `src/app/agent/startup-context.ts` and `src/app/gateway/main.ts` alongside the satellite registry.
- **AC:** absent file → empty registry, no boot failure; malformed file → hard parse error naming the field; duplicate `affordanceId` within a place rejected; `npm run build` + new `places-registry.test.ts` green.

**A2 [MVP] Bind satellites to places (static-only).**
- Add a typed `placeId?: string` to `SatelliteConfig` (`src/shared/contracts/satellite-registry.ts`) and thread it through `SatelliteRoutingMetadata` so it lands on the turn. Keep `staticLocationLabel` as the human display string; `placeId` is the machine binding. Validate at load time that a satellite's `placeId` exists in `places.json` **only if** `places.json` is present (soft cross-reference; fail closed only when both are configured).
- **Decision 6:** binding is **static**. No runtime auto-rebinding of a satellite to a new place. If a satellite physically moves, the operator/partner re-binds it via the admin UX (F1). Mobile devices (phones) are ordinary channels with global control only — they do **not** carry a `placeId` and get no room-scoped foregrounding. Do not build a dynamic/mobile `placeId` path.
- **AC:** a satellite with an unknown `placeId` (when `places.json` present) is rejected at load; `SatelliteRoutingMetadata.placeId` is populated on satellite turns; parity across agent/gateway load paths; no runtime-rebinding code path exists.

**A3 [MVP] Virtual place kind + MUD-over-Discord testbed.**
- `kind: 'virtual'` places carry virtual affordances (`backend: 'vr'` / virtual-object ids); no HA binding. **Decision 5:** the first virtual environment this sprint is a **text MUD run over the existing Discord channel** — virtual places + virtual objects driven through Discord, exercising the same `places.json` model, situated block, and `world` tool as physical rooms (only the effector backend and transport differ). This gives an end-to-end virtual testbed with no engine dependency. Unreal Engine 5 is a future-horizon non-goal (§6.8); a VR seat as a satellite is deferred with it.
- **AC:** a virtual place + virtual objects load from `places.json`; `world list/perceive/control` operate on them through the Discord channel; the situated block foregrounds the virtual place's affordances exactly as it does for a physical room.

**A4 [MVP] Publish world/place info into the companion wiki/vault.**
- **Decision 2:** beyond the machine-readable `places.json` registry, publish a human-readable, browsable projection of the world (sites, places, notable affordances, and any operator-authored place lore) into the companion's wiki/vault so she has **browsable world knowledge** she can read like any other note. This is a derived read-only projection of `places.json` (plus optional operator prose), not a second source of truth. Coordinate with the shared-world wiki MVP (`psfn-framework-i5s2`) for ACLs/review gates; publication respects those gates.
- **AC:** editing `places.json` (or re-running the publisher) refreshes the wiki/vault world pages; the pages are browsable by the companion; the registry remains the single source of truth (wiki is a projection); no prompt-time raw affordance dump.

### Workstream B — Situated context injection ("where am I / what's here / what can I do here")

**B1 [MVP] New runtime-context section producer.**
- New `src/core/agent/substrate-agent/runtime-context-sections/situated-presence.ts`, modeled on `satellite.ts` (`buildSatelliteEndpointContextBlock`). Inputs: `message.routing.satellite` (already carries `staticLocationLabel`/`mobility`, and after A2 `placeId`), `message.routing.presence` (`CompanionPresenceMetadata` — **carried today but consumed by nothing**; verified: zero consumers in `runtime-context-sections/`), and the resolved place + affordance list.
- Follow the idiomatic E2.5 layer pattern: emit **bare `runtime_situated_*` values** from `buildDynamicPromptTemplateVariables` (`runtime-context.ts`), plus a seeded operator-editable prompt layer for the wording, AND/OR render a `<runtime_situated_presence>` XML block from `buildRuntimeContext` exactly like `buildSatelliteEndpointContextBlock` is wired at the `buildRuntimeContext` call site.
- Content: current place display name; perceivers active here; effectors controllable here (the foregrounded local surface); a note that global control is available via the `world` tool.
- **AC:** a satellite turn with a resolvable `placeId` renders the block; a turn with no place resolves to no block (fail-closed, no fabricated location); the unused `routing.presence` field now has a consumer; snapshot test on the rendered block.

**B2 [MVP] Active-emanation integration.**
- Wire the situated block to `src/core/agent/active-emanation-state.ts` so "where am I *right now*" reflects the current active emanation (handoff-aware), not just the inbound message's satellite. When the companion emanates into the living room, the living-room affordances foreground.
- **AC:** switching active emanation between two satellites changes the foregrounded place in the next turn's block.

**B3 [MVP] Durable situated location state + bottom-of-prompt placement.**
- **Decision 3:** location is durable, not per-turn only. Add a `situated` sibling to `emotional/cognitive/attention/relational` in `src/core/self-model/state.ts`, surfaced via `internal-state.ts`, so the companion *remembers* where it is across turns and continuity gaps. This churns `normalizeInternalState`/`computeState` validators and the sha256 `buildInternalStateSnapshotRef` — budget for that.
- **Placement:** the current-location standing reminder renders near the **bottom of the prompt** (recency / time-ordered position), not with the top-of-prompt identity/system material, so it reads as "where I am right now." The B1 situated block supplies the content; B3 makes it durable and pins its position. Room-dependent affordances/tools are available while emanating in that place.
- **AC:** location persists across a turn boundary and a continuity gap (reload) without a fresh routing signal; the standing reminder renders at the bottom-of-prompt recency slot; snapshot-hash and self-model validators stay green.

### Workstream C — World control surface (HA + virtual)

**C1 [MVP] Gateway HA method (privileged, holds the token).**
- New `src/boundary/gateway/methods/home-assistant.ts` following the beads descriptor pattern (`methods/beads.ts` + `register.ts` `registerGatedDescriptors`). Descriptors: `home_assistant.get_states` (read), `home_assistant.call_service` (control). Each with `approvalAction`/`approvalScope`, redacted `summary`, arg validation, timeout, output cap, `runtime.recordAuditEvent`.
- HTTP to HA REST (`GET /api/states`, `POST /api/services/<domain>/<service>`) reusing `web.ts` machinery (`withWebCircuit` circuit breaker + redirect validation).
- **SSRF lane:** HA is on the LAN (RFC1918), blocked by the default policy. Use `src/boundary/gateway/url-policy.ts` `allowInternalNetwork: true` **plus** a `domainAllowlist`/host allowlist scoped to exactly the configured HA host:port. `ALWAYS_BLOCKED_RANGES` still blocks cloud-metadata/link-local even in this lane (verified `url-policy.ts:25,72,264`). Do **not** open a blanket internal-network egress — scope to the HA host only.
- **Credential:** `HOME_ASSISTANT_TOKEN` as a gateway-side env credential resolved via `CredentialVaultPort` (`src/boundary/custody/credential-vault.ts`, `resolveOptionalEnvCredential`), injected as `Authorization: Bearer`. **Never crosses to the agent process.** Method fails closed if the token is unset.
- **AC:** `get_states` returns entity states through the SSRF lane against a mock HA; `call_service` gated by approval; token absent → method errors, does not fall back; cloud-metadata IP still blocked even with `allowInternalNetwork`.

**C2 [MVP] Agent-side `world` tool (4-file integration).**
- New `src/boundary/integrations/world/{tools,ops,gateway-ops,runtime-wiring}.ts` following the beads template exactly:
  - `tools.ts` — `createWorldTool(ops)`: one action-dispatched tool, `actions: ['perceive','list','control']`. `perceive` reads current-place sensor states; `list` enumerates affordances (optionally site-wide); `control` calls an effector. Params carry optional `placeId`/`affordanceId`; default to situated place.
  - `ops.ts` — `WorldOperations` port; `gateway-ops.ts` — `GatewayWorldOps` forwarding to the RPC client; `runtime-wiring.ts` — `registerWorldTools(target, ops, {gatewayMode})` attaching `wiringMeta.requiredGatewayMethods = ['home_assistant.get_states','home_assistant.call_service']` (validated by `tool-wiring-validator.ts`), registering as `'extended'`.
- Add `world` fields to `GatewayOpsPort` (`src/boundary/gateway/gateway-ops-port.ts`) + client methods; register method in `src/boundary/gateway/methods/index.ts`; wire `registerWorldTools(...)` in `src/app/agent/main.ts`.
- Affordance→entity resolution happens **agent-side against `places.json`** (the agent knows the map); the gateway only ever sees a validated HA `entity_id`/`service` — the agent cannot ask the gateway to hit an arbitrary entity outside the registry (defense in depth).
- **AC:** `world perceive` in the living room returns that room's presence/sensor state; `world control lr_lights off` turns them off through the gateway; an `affordanceId` not in `places.json` is rejected agent-side before any RPC.

**C3 [MVP] Tool surface registration + capability/trust gating.**
- Add a `world` entry to `CANONICAL_FIRST_PARTY_TOOL_SURFACES` (`src/core/agent/tool-surface/registry.ts`): `exposure: 'extended'`, appropriate `domain`, `actions: ['perceive','list','control']`, `capabilityMetadata` action-aware. **Required** or the drift guard (`assertNoRetiredFirstPartyToolAliases`) fails the build.
- Add tokens `world.read` and `world.control` to `CAPABILITY_TOKENS` (`src/system/capabilities/tokens.ts`) — verified the current list has no world token.
- Add a `resolveWorldRequirement` to `UNIFIED_TOOL_REQUIREMENT_RESOLVERS` (`src/system/capabilities/requirements.ts`): `perceive`/`list` → `world.read`; `control` → `world.control`.
- Tier defaults (`src/system/capabilities/tiers.ts` + `config/capability-tier.seed.json`): grant `world.read` at `apprentice`+; **withhold `world.control` from all default tiers** (see C4).
- Requester-trust gating: effector control requires a `primary`/`trusted` requester (owner/partner via `src/system/trust/`), enforced at the gateway approval boundary and/or a per-affordance allowlist. The satellite endpoint's `channelPrivacy` + `defaultIdentity` give a room-scoped trust anchor.
- **AC:** a `regular`/`public` requester cannot invoke `world control`; `world.control` absent from `nursery`; capability gate hides `control` action when token absent; tests cover the deny paths.

**C4 [MVP] Stage `world.control` OFF by default (robotics pattern).**
- Mirror the established modeled-but-disabled pattern: `robotics` is in `SATELLITE_CAPABILITIES` but excluded from `SATELLITE_RUNTIME_ENABLED_CAPABILITIES` (verified `satellite-registry.ts:23,28`). `world.control` ships **defined, wired, gated, and off** until the control path is proven end-to-end against real hardware. Read (`perceive`/`list`) may ship live.
- **AC:** with default config, the companion can perceive the world but cannot actuate; enabling control is a single explicit config/tier change, documented.

**C5 [STG] Virtual-object control.**
- `world control` with a `vr:` affordance routes to a virtual-object backend instead of HA. Generalizes cleanly: the tool and situated block are backend-agnostic; only `gateway-ops`/method routing branches on `backend`. Concrete VR target deferred (Open Question 5).

### Workstream D — Perception ingestion (sensor → cognition bridge)

**D1 [MVP] Agent-side consumer for `external.telemetry.ingested`.**
- The sensor ingress exists (`src/shared/telemetry/sensor-ingest-port.ts` emits `external.telemetry.ingested`; also the reverse gateway method `api.telemetry.ingest`) but **every consumer today is Garden/observability** — verified: `telemetry-correlation.ts`, `audit-event-collector.ts`, `server-telemetry-transport.ts`. **Nothing in `core/agent` consumes it.** `wake-window-estimator.ts` explicitly leaves this for later.
- Add a new event-bus consumer in `core/agent` (a `SensorCognitionBridge`) subscribing to `external.telemetry.ingested`, filtered to `presence`/`face` telemetry scopes, keyed to a satellite→place.
- **AC:** an ingested presence event on the living-room satellite reaches the bridge; a Garden-only observability event does not trigger cognition twice (idempotency/dedup considered).

**D2a [MVP] Hub identity ↔ contact enrollment flow.**
- **Decision 4:** biometric compute and templates live entirely at the endpoint + Satellite Hub (separate repo) and **never enter core**. Core owns an owner-controlled **enrollment flow** that binds a hub-side biometric identity handle (an opaque `hubIdentityId`) to a core contact profile (contact id ↔ hub identity). Store the binding in a companion-owned table/registry (model on the contacts channel-identity plumbing in `src/core/contacts/`; keep it semantically separate from conversational channel identities). Enrollment is initiated/approved by the owner (Garden surface in F1) — a hub identity is meaningless to core until the owner explicitly binds it.
- **AC:** the owner can bind a `hubIdentityId` to an existing contact and unbind it; an unbound `hubIdentityId` resolves to unknown; the binding is owner-only in Garden; no biometric template is ever accepted or stored by core.

**D2b [MVP] Resolve presence identity claim → contact, fail-closed.**
- Presence events arrive carrying an **already-resolved identity claim** (`hubIdentityId` + confidence), **not** biometric data. Resolve `hubIdentityId` → contact via the D2a enrollment binding → `getById(canonicalContactId)` (`src/core/contacts/`). `relationshipType: 'partner'` already exists.
- **Fail closed on identity:** an unbound or low-confidence claim surfaces as "an unrecognized person," never a guessed name. Do not leak a non-owner's identity beyond what trust allows (Section 5).
- **AC:** a claim for an enrolled partner → contact resolves; an unbound claim → generic; a low-confidence claim → generic (no fabricated identity); core rejects any event that carries raw biometric payload instead of a claim.

**D3 [MVP] Deliver perception into cognition via context-visible notes.**
- Use the canonical async lane `SessionManager.appendContextSystemNote(channelId, note, source)` (verified `src/core/session/manager.ts:1030`) — the same mechanism `scheduler/temporal-wakeup.ts` uses. Post to the **active satellite session channel** so the note lands in that place's session scope (sessions are channel-keyed; a satellite already gets its own scope).
- Note content is trust-gated (Section 5): "Someone entered the living room" vs "Your partner entered the living room."
- **AC:** a presence event produces a `[SYSTEM: ...]` note in the correct place's session; the note respects trust gating; no note leaks to the wrong channel scope.

**D4 — promoted to Workstream G.** Proactive wakeup on perception is now **in scope** per Decision 7 and lives in the new **Workstream G** (proactive presence & conversation continuity) below. This D4 slot is retained only as a pointer.

**D5 [STG] Inbound HA state stream.**
- MVP perception comes from satellites POSTing telemetry (D1). To also react to HA-side state changes (a light someone else toggled), add either a scheduler self-poll of `GET /api/states` deltas (lowest risk) or a gateway-side HA `/api/websocket` subscriber that injects via a reverse method alongside `api.telemetry.ingest`. Defer; poll first if needed.

### Workstream E — Persistence & memory

**E1 [MVP] Location on TurnRecord.**
- `TurnRecord` (`src/shared/contracts/runtime.ts`) persists `channelId`/`channelType` but **no satellite/place field** (verified) — origin is ephemeral to the live turn. Add optional `placeId?`/`satelliteId?` for durable origin history. Thread through the sessions store (`src/persistence/sessions/store`) with a `hasColumn`-guarded `ALTER TABLE ADD COLUMN` migration (established idiom, e.g. `contacts/store/schema.ts`).
- **AC:** satellite turns record their `placeId`; migration is idempotent; absent on non-satellite turns (nullable).

**E2 [MVP] Memory location tagging (low-friction first).**
- `l2_memories` (`src/faculties/memory/store/schema.ts`) has no location column. Tag location into the existing `tags`/`scope_tags` JSON arrays (e.g. `tags: ["location:living_room"]`) — zero schema change, flows through existing retrieval. A typed `location_ref` column (mirroring the `scope_ref_kind/id/label` triple) is deferred until spatial retrieval/filtering is a hard requirement.
- **AC:** memories formed on a satellite turn carry a `location:<placeId>` tag; retrieval unaffected; no schema migration in the MVP.

**E3 [STG] Contact physical presence / spatial last-seen.**
- Contacts have conversational `lastSeen` and the `contact_channel_activity` roster, but **no physical/spatial presence** (verified `src/core/contacts/types.ts`). Add a `physicalLastSeen`/`presentInPlace` surface distinct from conversational last-seen, updated by the D2 face-resolution path. Sensitive data — see Section 5. Model on the roster machinery but keep semantically separate (roster = conversation channels).
- **AC:** a recognized partner presence updates `physicalLastSeen`; the field is never routed into prompt content beyond trust-gated situated notes; owner-only in Garden.

### Workstream F — Garden admin + docs + validation

**F1 [MVP] Places/affordances admin surface + static satellite re-bind + enrollment.**
- New `src/operator/garden/api-routes-places.ts` + `src/operator/garden/services/places-service.ts` modeled on `api-routes-rooms.ts` + `rooms-service.ts` (verified templates exist). Read-first (`Cache-Control: no-store`, DATA only), mounted in `api-routes.ts`, auth via `server-auth.ts`. Read the new `places.json`; show sites/places/affordances and each satellite's `placeId` binding. **Name it "places," never "rooms"** in the API path (`/api/admin/places`) to avoid the existing rooms route collision.
- **Static re-bind (Decision 6):** the owner/partner can re-bind a satellite to a different `placeId` here when a device physically moves rooms. This is the *only* rebinding path — there is no runtime auto-rebinding.
- **Enrollment (Decision 4):** owner-only surface to bind/unbind a hub identity (`hubIdentityId`) to a contact (the D2a flow). No biometric data is shown or stored — only the opaque handle and the contact link.
- **AC:** `/api/admin/places` returns the registry; owner-authenticated; the owner can re-bind a satellite's `placeId` and bind/unbind a `hubIdentityId`↔contact; no prompt exposure of raw affordance data; no biometric payload anywhere in the surface.

**F1b [STG] World-mapping Garden tool.**
- **Decision 2 (future UX):** a visual world-mapping tool in Garden — lay out sites/places, drag satellites/affordances onto a map, author place lore that feeds A4's wiki publication. Builds on the F1 read surface. Stretch; ship the read/edit-JSON surface first.

**F2 [MVP] Settings-contract / owner-file compliance.**
- If any runtime-toggle keys are surfaced (e.g. HA base URL, world-control enable), satisfy `src/system/config/settings-contract-guard.ts` (`verifySettingsContractGuard`): unique `ownerFile`, Garden exposure metadata + raw-editor coverage. `places.json` as a soft-registry needs no strict owner-file boot gate (A1); the HA connection settings (base URL, token env name) may live in `settings.json` or a dedicated block — decide in F2.
- **AC:** `npm run verify:settings-contract` green; `npm run verify:repository-hygiene` green.

**F3 [MVP] Tests + e2e + docs.**
- Unit tests for every new contract/loader/producer/tool/gate. An e2e that drives a satellite turn → situated block → `world perceive`/`control` against a mock HA. Update `docs/architecture.md`, `docs/CODEBASE_MAP.md`, `docs/tool-surface.md`, and add a `docs/world.md` (or `docs/locations.md`). Keep docs+config+tests in the same change per `CLAUDE.md`.
- **AC:** `npm run build`, `npm test` (targeted), `npm run lint` green; new e2e green; docs reflect the shipped surface (no hardcoded tool counts).

### Workstream G — Proactive presence & conversation continuity

**Decision 7** puts proactive presence in scope. Conversations follow the user room to room, and entering a room can fire location-relevant concerns.

**G1 [MVP] Conversation-follows-you: session handoff on presence room change.**
- When a presence event fires on a *different* satellite/place than the active emanation (the user says "I'm going to the kitchen," leaves the bedroom, presence lands on the kitchen satellite), hand off the active emanation and continue the same conversation in the new place rather than starting cold. Wire to `src/core/agent/active-emanation-state.ts` (the B2 handoff surface) driven by the D1 sensor→cognition bridge; the situated block (B1/B3) then foregrounds the new room.
- Guardrails: debounce/settle so passing through a room doesn't thrash the emanation; only follow on a confident presence claim for the owner/partner (trust-gated, Section 5); do not follow into a place with no bound satellite.
- **AC:** a presence event on place B while emanating in place A moves the active emanation to B and the live session continues (context carried, not reset); rapid transient events do not thrash; an unrecognized/low-confidence presence does not trigger a follow.

**G2 [MVP] Location-scoped concerns/reminders fire on presence events.**
- Entering a place can trigger a proactive internal turn scoped to that place's concerns ("don't forget to drink water," "bring down snacks"). Model location-scoped concerns/reminders (an owner-/companion-authorable set keyed by `placeId`) and fire them on the D1 presence event via the heartbeat/internal-turn path (`scheduler/scheduler.ts` → `heartbeat-post-turn-runtime.ts`). Respect the LLM-call-economy principle: a cheap deterministic gate (is there an eligible unfired concern for this place? has it fired recently?) decides *whether* to spend a turn, before any LLM call.
- Future embellishment (avatar visually "runs into frame" on the destination satellite, procedural animations) is horizon, not built here (§6.8).
- **AC:** entering a place with an eligible location-scoped concern fires exactly one proactive turn; a place with no eligible concern fires nothing; the deterministic gate prevents repeat/duplicate firing and respects charge; concerns are owner-only editable in Garden.

---

## 4. Sequencing, Dependencies, MVP vs Stretch

```
A1 places.json ──► A2 satellite↔place (static) ──► B1 situated producer ──► B2 active-emanation ──► B3 durable + bottom-of-prompt
       │                     │                          │
       │                     │                          ▼
       │                     │                   G1 conversation-follows-you ──► G2 location-scoped concerns
       │                     │
       ▼                     ▼
  A4 wiki publish     C1 HA gateway method ──► C2 world tool ──► C3 gating + staged-off control
       │                     │                                     ▲
       ▼                     ▼                                     │
  A3 MUD-over-Discord   D1 telemetry bridge ──► D2b claim→contact ─┘
                             │        ▲
                             │        │ D2a hub-identity↔contact enrollment
                             ▼        │
                      D3 context notes┘
                             │
                             ▼
                      E1 TurnRecord ──► E2 memory tags
                             │
                             ▼
                      F1 admin (+re-bind +enrollment) ──► F2 settings-contract ──► F3 tests+docs
```

**MVP (coherent first ship):** A1, A2, A3 (MUD-over-Discord), A4, B1, B2, B3, C1, C2, C3 (registration+gating+staged-off control), D1, D2a (enrollment), D2b, D3, E1, E2, F1, F2, F3, G1, G2.
This delivers: the companion knows where it is (durably, bottom-of-prompt), foregrounds the local surface, can **perceive** the world and (behind a staged-off flag) **control** it, reacts to presence events with fail-closed identity resolution against owner-enrolled hub identities, follows the user room to room, fires location-scoped concerns, records origin, publishes browsable world knowledge, and has an admin surface with static re-bind + enrollment. Control ships gated-off until proven.

**Stretch:** F1b (world-mapping Garden tool), D5 (HA event stream), E3 (contact physical/spatial presence).

**Future-horizon non-goals (§6.8, tracked in the deferred bead):** UE5 embodiment, GPS/phone-app geofenced reminders, robot/VR self-locating, live biometric matching in core.

**Critical path:** A1 → A2 → B1 → B2 → B3 (nothing foregrounds or persists without the place binding), and C1 → C2 → C3 (the control surface with gating). D2a enrollment gates D2b claim resolution. G1/G2 depend on D1 (presence bridge) + B2/B3 (emanation + durable location). B, C, and D are parallelizable after A2. Perception (D) is independent of control (C).

### What ships where (this repo vs Satellite Hub)

- **This repo (PSFN):** `places.json` registry + loader, satellite↔place binding, situated context producer, `world` tool + HA gateway method, SSRF lane, capability/trust gating, sensor→cognition bridge, contact/face resolution, persistence, Garden admin, docs. **All of Workstreams A–F.**
- **Satellite Hub repo (separate, already extracted):** the device firmware/runtime that reads mmwave/camera/mic and **POSTs telemetry** to `api.telemetry.ingest` with `X-PSFN-Satellite-*` headers; the Wyoming/OpenHome endpoint transport. The sensor *producers* live there; this repo *consumes*. **Per Decision 4, face-recognition compute and all biometric templates live here (endpoint + Hub) and never enter core** — the Hub emits a resolved identity *claim* (`hubIdentityId` + confidence); core binds that claim to a contact via the D2a enrollment flow.
- **External (operator-owned):** the Home Assistant instance itself. This repo talks to it via gateway egress; it is not vendored.

---

## 5. Security & Privacy Posture

Presence data — especially **face detection of non-owner people** — is among the most sensitive data this system will touch. Posture:

1. **Fail closed on identity.** Unrecognized or low-confidence face → "an unrecognized person," never a guessed name. No fabricated location either: a turn with no resolvable place renders no situated block (B1). (Anti-Replika guarantee: the companion never invents where it is or who's there.)
2. **Control staged off by default (C4).** `world.control` follows the `robotics` modeled-but-disabled pattern — defined, wired, gated, and **off** until the actuation path is proven end-to-end. Perception may ship live.
3. **Effectors are trust-gated (C3).** Actuation requires a `primary`/`trusted` requester (owner/partner). A `regular`/`public` requester in a shared space cannot control the home. Enforced at the gateway approval boundary + capability token, with per-affordance/per-place approval scope and full audit (`recordAuditEvent`).
4. **Trust-gated perception disclosure (D3).** A detected non-owner's identity is disclosed into cognition only as far as trust permits: "someone entered" for strangers; named only for contacts the current requester/context is entitled to know about. Face→contact never leaks a third party's identity into a lower-trust channel scope.
5. **SSRF lane scoping (C1).** The HA lane uses `allowInternalNetwork` + a host allowlist scoped to exactly the HA host:port — not blanket internal egress. `ALWAYS_BLOCKED_RANGES` still blocks cloud-metadata/link-local in this lane. Post-DNS re-check defeats rebinding (existing `url-policy.ts`).
6. **Token isolation.** `HOME_ASSISTANT_TOKEN` is a gateway-side vault credential, injected as a Bearer header on the gateway; it never crosses to the isolated agent process. Method fails closed if unset.
7. **Defense in depth on entity addressing (C2).** The agent resolves `affordanceId` → HA `entity_id` against `places.json` before any RPC; the gateway validates against the same registry. The model cannot address an arbitrary HA entity outside the registry.
8. **`companion-data` sacrosanct.** Contact physical-presence (E3) is companion-owned, owner-only in Garden, and never routed into prompt beyond trust-gated situated notes.
9. **Biometrics never enter core (Decision 4).** Face-recognition compute and biometric templates live entirely at the endpoint + Satellite Hub. Core receives only a resolved identity *claim* (an opaque `hubIdentityId` + confidence) and rejects any event carrying a raw biometric payload. A `hubIdentityId` resolves to a person only through an owner-approved enrollment binding (D2a); unbound or low-confidence claims are treated as unknown. This keeps the most sensitive data class out of the substrate entirely.

---

## 6. Decisions (2026-07-08)

The operator resolved the prior open questions. These are now binding for the sprint; the workstreams above and the sequencing below have been rippled to match. Epic: `psfn-framework-vinz` (`[S10] Location data & world control surface`).

1. **`places.json` stays a separate soft-registry.** Confirmed. Keep `satellites.json` as the lean security-authoritative claim spine; `places.json` owns places + affordances (Workstream A1). (Resolves prior Q1.)
2. **HA connection settings: base URL + long-lived token, gateway-side, kept simple.** No elaborate owner block. Base URL + token env-name live gateway-side; the token resolves via the credential vault and never crosses to the agent (Workstreams C1/F2). (Resolves prior Q2.)
3. **Location state is durable, not per-turn only.** The companion *remembers* where it is across turns and continuity gaps. Current location renders near the **bottom of the prompt** (time-ordered / recency position) as a standing reminder, and the current room's affordances/tools are available while emanating there. B3 is therefore **promoted to MVP** (durable situated state + bottom-of-prompt placement). (Resolves prior Q3.)
4. **Biometrics are held entirely at the endpoint + Satellite Hub (separate repo).** Face-recognition compute and biometric templates **never enter core.** Core's job is an **enrollment flow** that binds a hub-side biometric identity to a core contact profile (contact id ↔ hub identity). Presence events arrive with an already-**resolved identity claim**, not biometric data. D2 is reframed accordingly, and a new enrollment task is added (Workstream D). (Resolves prior Q4.)
5. **First virtual environment = a text MUD over Discord.** Eventual target is Unreal Engine 5 (operator's friends are building there), but for **this sprint** we model a text-based MUD run over the **existing Discord channel**: virtual places + virtual objects driven through Discord, before any real-engine integration. This replaces the abstract "VR place" stretch items with a concrete, testable testbed (Workstream A3, reframed). UE5 is a future-horizon non-goal (see §6.8). (Resolves prior Q5.)
6. **Satellites are static this sprint.** Satellite↔place binding is static. If a satellite physically moves rooms, the operator/partner **re-binds it in the admin UX** — there is no runtime auto-rebinding. Mobile devices (phones) act like normal channels but retain **global** control only (no room-by-room; the hardware can't do indoor positioning). Robot / physical self-locating and VR self-locating are future state. A2 is simplified to static-only; any dynamic mobility work is removed. (Resolves prior Q6.)
7. **Proactive presence behavior is in scope.** Conversations **follow the user room to room**: the user says "I'm going to the kitchen," leaves the bedroom, presence fires on the kitchen satellite, and the session/conversation continues there. Entering a room can also fire **location-scoped concerns/reminders** ("don't forget to drink water," "bring down snacks"). This is captured as a new **Workstream G** (proactive presence & conversation continuity), which absorbs and promotes the old D4 stretch item. Future embellishment (avatar visually "running into frame," procedural animations) is noted as horizon, not built this sprint. (Resolves prior Q7.)
8. **Explicit future-horizon non-goals (OUT of Sprint 10).** These are deliberately deferred, not forgotten (tracked in the deferred horizon bead):
   - **Unreal Engine 5** embodiment / real-engine virtual world (MUD-over-Discord is the sprint stand-in).
   - **GPS / phone-app geofenced reminders** (e.g. at the grocery store → "buy more chicken for dinner").
   - **Robot / physical-space self-locating** and **VR self-locating** (avatar running into frame, procedural animations).
   - **Live biometric matching inside core** (compute stays at the Satellite Hub; core only binds resolved identity claims).
```
