# World — Sites, Places, Affordances & Embodiment

> **Working draft** in `working_docs/docs-gap/world.md` — promote to `docs/world.md` after review.
> **System:** `world` (`system:world`) · **Code:** `src/boundary/integrations/world/` (gateway-ops, tools, runtime-wiring) + `src/channels/backplane/places-registry.ts` + `src/channels/backplane/places-mermaid.ts` + `src/faculties/wiki/` + `docs/world-map.mmd` + `docs/productivity-pack.md`
> **Tracker:** `working_docs/docs-gap/TRACKER.md` #5 · **Status:** draft from code @ 2026-08-06

## Orientation

World is how a companion perceives and acts beyond chat: a **Site** (e.g., Home) contains **Places** (Bedroom, Kitchen), each Place exposes **Affordances** — perceivers (presence sensors) and effectors (lights) — bound to Home Assistant entities via `places.json`. A companion navigates virtually between places, perches, and triggers effectors through a single `world` tool. The mermaid map (`docs/world-map.mmd`) is the Operator-visible mirror of that registry (`npm run map:places`).

**Who it's for:** contributors wiring HA entities or a new satellite embodiment, operators curating `places.json`, and reviewers auditing physical-world actuation.

**Fits between:** `channels.md` (registry + backplane) → here (sites/places/affordances) → `memory.md` (wiki + places-wiki publication) → `productivity-pack.md` (Personal Operations Pack's Dayboard/Partner Model over this substrate).

## Mental model

```
places.json (owner file, DATA_DIR)
   └─ PlacesRegistryConfig ─┬─ site: "Home" ─┬─ Bedroom (physical) ─► Bedroom Lights (light · ha · effector)
                            │                ├─ Kitchen (physical)  ─► Kitchen Lights (effector) + Kitchen Presence (perceiver)
                            │                ├─ Living Room          ─► …
                            │                └─ Office               ─► …
                            └─ satellite binding (cert pin, src/app/cert-manager/) ─► satellite hub (mTLS)
                                    │
Agent world tool (src/boundary/integrations/world/tools.ts) ─► Gateway world ops (gateway-ops.ts, ops.ts)
  actions: perceive | list | control | move                     └─ HA service call (entity_id proven in registry)
CompanionPresenceTurnPort.recordDeliberateMove(...)  ◄── move is virtual-only; physical presence is emanation-driven
```

Generated map: `docs/world-map.mmd` (from `places.json` + `satellites.json` via `renderPlacesMermaid` in `src/channels/backplane/places-mermaid.ts`).

## Entry points

| Entry | Location | Purpose |
|-------|----------|---------|
| `world` tool | `src/boundary/integrations/world/tools.ts:25` | Single action-dispatched tool: `perceive` (read HA state + summary), `list` (enumerate affordances), `control` (call HA service on effector), `move` (virtual navigation) |
| `WorldOperations` | `src/boundary/integrations/world/ops.ts` | Port over gateway HA ops (read states, call service) — agent-side validates `affordanceId/placeId` present in registry **before** any gateway RPC (defence in depth, `:33`) |
| `runtime-wiring.ts` | `src/boundary/integrations/world/runtime-wiring.ts` | Wires `CompanionPresenceTurnPort` + `RoomEntryNoteSink` + situated `Here:` block |
| `places-registry.ts` | `src/channels/backplane/places-registry.ts` | Owner-file CRUD + validation for `PlacesRegistryConfig` (site/place/affordance shapes) |
| `places-mermaid.ts` | `src/channels/backplane/places-mermaid.ts` | `renderPlacesMermaid(places.json, satellites.json)` → `docs/world-map.mmd` |
| `CompanionPresenceTurnPort.recordDeliberateMove()` | `src/core/agent/companion-presence-runtime.ts` (via `tools.ts:42`) | **Exclusive** write path for virtual `move` — also emits co-location events, situated overlay, and wiki shared-scope swap |
| `gateway-ops.ts` | `src/boundary/integrations/world/gateway-ops.ts` | Gateway-side HA adapter (service calls, sensor bridge) |
| `wiki/` + `places-wiki-publication` | `src/faculties/wiki/`, `places-wiki-publication.ts` | Per-place wiki shared-scope that swaps on `move` |

## Key types

| Type | Location | Purpose |
|------|----------|---------|
| `PlacesRegistryConfig` / `PlaceConfig` / `AffordanceConfig` | `src/shared/contracts/places-registry.ts` | `{site, places:[{placeId, kind: physical|virtual, affordances:[{affordanceId, kind: light|presence|… , entity_id, capability}] }] }` |
| `WorldAction = perceive\|list\|control\|move` | `src/boundary/integrations/world/tools.ts:68` | Tool action discriminant (`WORLD_ACTION_HELP = 'perceive, list, control, move'`) |
| `WORLD_CONTROL_RUNTIME_ENABLED` | `src/boundary/integrations/world/tools.ts:66` | Master kill-switch for effector actuation (embedding may override to `false` without disabling perception) |
| `RoomEntryNoteSink` / `RoomEntryOccupant` / `ROOM_ENTRY_NOTE_SOURCE` | `src/core/session/room-entry-note.ts` (via `tools.ts:13`) | Room-entry notes planted on move (`composeRoomEntryNote`) |
| `SituatedPlaceRef` | `src/core/agent/substrate-agent/runtime-context-sections/situated-presence.ts` | `Here:` block shown in agent context on virtual move |

## Data flow

### Read: `perceive` / `list`

1. Agent calls `world` with `{action: 'perceive', placeId}` or `{action:'list', placeId?}`.
2. Agent-side resolves `placeId/affordanceId` against `PlacesRegistryConfig` (in-memory from `places.json`). Unknown → fail-closed before gateway RPC.
3. Gateway `ops.ts` reads HA states for that place's affordances and returns a summary + affordance list. No capability beyond read.

### Write: `control`

Three **independent, fail-closed** gates (`tools.ts:48`):

1. Capability token `world.control` (only autonomous + explicitly configured custom tier surface control).
2. Runtime master gate `WORLD_CONTROL_RUNTIME_ENABLED`.
3. Requester provenance + trust: primary/trusted scope; self-directed turns additionally need recognized intent + audit reason and are restricted to registered `light` affordances.

On pass, `entity_id + service` proven in step 2 is sent to the gateway HA adapter — the gateway never receives an unproven `entity_id`.

### Move: `move` (virtual-only)

* `move` is **virtual places only** (contract `s10wm`, `vinz.26`). Physical `placeId` → fail-closed with explain-why error; physical presence is emanation-driven via the sensor bridge, not a tool.
* The only write path is `CompanionPresenceTurnPort.recordDeliberateMove()` (`:42`) — never the shared `companion_presence` table directly — so co-location events, the situated `Here:` block, and the wiki shared-scope swap all follow from one seam. Flag-off (single-companion, no port wired), the move is **local-only** (overlay updates, no shared-table write).
* On move, `composeRoomEntryNote` plants a `ROOM_ENTRY_NOTE_SOURCE` system note via `RoomEntryNoteSink`.

## External dependencies

| Dependency | Purpose | Critical |
|------------|---------|----------|
| `places.json` (owner file) + `satellites.json` | Places/affordances/entities + satellite pins → map generation | Yes if world enabled |
| Home Assistant (HA) | Entity state + service calls (via gateway HA adapter) | For effectors/perceivers |
| PostgreSQL (`companion_presence`, wiki) | Presence + per-place shared wiki scope | For multi-companion/virtual navigation |
| `EventBus` / session note sink | Room-entry notes, presence co-location events | Yes |
| `docs/world-map.mmd` generated asset | Operator Garden view / `npm run map:places` | Derived |

## Configuration

| Source | Priority | Example |
|--------|----------|---------|
| `places.json` (in `DATA_DIR`) | Canonical | `{sites:[{siteId:"home", places:[{placeId:"kitchen", kind:"physical", affordances:[{affordanceId:"kitchen-lights", kind:"light", entity_id:"light.kitchen"}]}]}]}` — validate via `places-registry.ts` + `places-mermaid.test.ts` |
| `world` block in owner files / `WORLD_CONTROL_RUNTIME_ENABLED` | Runtime gate | Embeddings may override master gate to `false` |
| Capability `world.control` | Authz | Granted only to autonomous tier + explicit custom tiers |
| Env | None | No world config lives in `.env` |
| `npm run map:places` | Derived artifact | Regenerates `docs/world-map.mmd` from `places.json` + `satellites.json` |

## Test infrastructure

| Type | Location | Coverage |
|------|----------|----------|
| Unit | `src/boundary/integrations/world/tools.test.ts`, `runtime-wiring.test.ts`, `gateway-ops.test.ts` | Unknown affordance → fail-closed before RPC, master-gate toggle, virtual-only `move`, local-only fallback |
| Registry | `src/channels/backplane/places-mermaid.test.ts`, `places-registry.test.ts` | Registry → mermaid rendering, validation |
| Wiki | `src/faculties/wiki/places-wiki-publication.test.ts` | Scope swap on virtual move |

## Pitfalls & gotchas

* **Don't invent entity IDs.** Every `control` `entity_id` must be proven in `places.json` agent-side first — the gateway re-validates but the defence-in-depth is the agent proof.
* **Physical places are not moveable.** `move` to a physical `placeId` must fail closed — use satellite/emanation presence, not navigation.
* **Never write `companion_presence` directly.** Always go through `CompanionPresenceTurnPort.recordDeliberateMove()`; direct writes orphan the `Here:` block and wiki swap.
* **Regenerate the map.** Editing `places.json` without `npm run map:places` drifts `world-map.mmd` — Garden shows the stale map. CI check is expected.
* **Pack ≠ world.** The Personal Operations Pack (`docs/productivity-pack.md` — Dayboard, Partner Model) is an optional product *over* world; disabling the Pack leaves world (`places.json`, wiki, presence) intact (invariant 2.1).

## Cross-links

* `docs/channels.md` (places/satellite registries), `docs/garden-control-plane.md` (Garden world/places view), `docs/memory.md` (wiki + journal), `docs/productivity-pack.md` (Dayboard/Partner Model target architecture), `docs/world-map.mmd` (generated visualization), `docs/attribution.md` (session attribution in world notes)

## Promotion notes

Move to `docs/world.md` (narrative companion to `world-map.mmd`); link from `docs/architecture.md` (Core Subsystems → World) + `docs/specifications.md`. Keep `npm run map:places` in `docs/operations.md` checklist.
