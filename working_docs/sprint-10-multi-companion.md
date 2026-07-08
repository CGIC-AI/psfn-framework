# Sprint 10 — Multi-Companion Substrate

Status: planning draft (2026-07-08). Produced from a five-way codebase survey (persistence, composition, shards/fatigue/trust, Garden, locations/wiki). File refs are as of `main` @ `277e8084`.

Companion doc: [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (epic `psfn-framework-vinz`) defines the location/world-control surface for a **single** companion — the place/affordance model (`places.json`), situated context, the `world` tool, presence ingestion, and the MUD-over-Discord virtual testbed. This doc plans the **multi-companion substrate** and layers multi-companion semantics (co-presence, companion↔companion conversation, shared world wiki) on top of that model. Terminology here follows the locations doc: **site / place / affordance / presence** — not "rooms" (Garden rooms are conversation channels).

## 1. Vision

Move from "1 companion core, 1 garden, 1 gateway, 1 Postgres = one companion" to:

- **One gateway, one database, many companions.** Each companion is distinct — not a shard. Own durable-object storage, own L0 session history, own memory, own character card, own config, potentially own models.
- **Flag-gated, not default.** Single-companion remains the default topology; multi-companion is an explicit opt-in.
- **Shared world, personal selves.** Companions share a world-info wiki and a locations model (virtual environments like a university or monastery with navigable rooms), while keeping personal wikis and personal memory strictly separate. World info swaps as a companion moves between areas (physical or virtual) without touching personal data.
- **Inter-companion protocol (ICP).** Companions on the same cluster or different clusters converse — governed by the fatigue system (loop prevention) and the same trust/privacy machinery as every other contact.
- **Purpose:** companions enjoy their own time inhabiting their own worlds, co-located conversation when in the same virtual room, and visits between physical-emanation companions and virtual-resident companions.

## 2. What the survey found (current state)

### 2.1 The seams are better than expected

The codebase already anticipates much of this:

| Existing capability | Where | Relevance |
|---|---|---|
| `COMPANION_ID`, `COMPANION_DATA_DIR`, `CHARACTER_CARD_PATH` env vars per agent process | `scripts/start-gateway-agent.sh:128-211`, `src/system/config/load-config.ts:91-97,255` | Per-companion identity + storage already parameterized — currently used as a label, never a routing key |
| All companion file artifacts resolve through one chokepoint | `src/persistence/layout.ts:356-371` (`resolveRuntimePathSnapshotFromConfig`) + ~50 `resolve*Path` helpers | `companion-data/<id>/` roots are nearly free |
| Gateway RPC is already per-connection | `src/boundary/gateway/server.ts:113-114` (`Map<conn, client>`), `identifyConnection` stamps a role (`server.ts:574-587`) | Adding `companionId` to identify + a routing table is a contained change |
| Per-request model selection | `src/boundary/gateway/protocol.ts:68-87`, `methods/llm.ts:353-388` | Different companions using different models already works at the request level |
| Fatigue engine charges only MI↔MI turns, per `{localCompanionId, peerContactId, channelId, dayKey}` | `src/core/agent/fatigue/policy.ts:214-236`, `fatigue-budget.ts` | The anti-loop invariant for ICP already exists; a human in the loop makes turns free |
| `companion_room` / `quiet_companion_room` fatigue channel settings + budgets | `config/charge-policy.seed.json:47-108`, `runtime-enforcement.ts` (`resolveFatigueChannelType`) | The codebase literally anticipates companion-to-companion rooms |
| Bot↔bot loop termination is proven | `two-companion-loop.test.ts` | Drives the real engine through a bot↔bot exchange, asserts bounded looping |
| Companion-as-contact | `src/core/contacts/types.ts` — `isMachineIntelligence`, `relationshipType: 'ai_companion'`, auto-detection in `observed-machine-intelligence.ts` | Trust tiers + disclosure gating apply to peer companions almost for free |
| Quarantine→review→promote ingestion | `src/faculties/shards/fold-review.ts`, `tool-sync.ts` | The right pattern for ingesting a *peer's* asserted memories/artifacts without trusting them |
| Provenance envelope | `shard result lineage` (`lineage-contracts.ts:44-59`: `coreCompanionId`, `shardCompanionId`, provenance) | Ready model for tagging cross-companion assertions |
| Authenticated cross-node transport | satellite backplane (`src/channels/backplane/satellite-registry.ts`, claim headers + client-cert fingerprints, capability tokens) | Strongest foundation for cross-cluster ICP |
| Channel adapter port abstraction | `src/channels/backplane/types.ts:66-90` (`ChannelAdapterPort`) | A companion-to-companion channel can be "just another channel," inheriting the whole turn pipeline (fatigue, trust, context envelope) |
| Wiki system (= the world-info system) | `src/faculties/wiki/` — store, pgvector projection, retrieval plan with token caps, nightly `SleeptimeWikiPass`, `wiki` tool, Garden UI route | Mature. Charter Law 32 / §6.26: wiki is world knowledge, explicitly NOT lived memory (L0/L0.1/L2) |
| Personal/world boundary filter | `sleeptime-wiki-pass.ts:302-342` (`filterPersonalFactProposals`) | Deterministic guard that already rejects personal facts leaking into world knowledge — exactly the shared-vs-personal boundary we need |
| Presence/emanation model | `src/core/agent/presence-metadata.ts`, `active-emanation-state.ts`, `ambient-presence.ts`; satellite `staticLocationLabel`/`siteId` | Models which device/channel a companion is active on — the nearest existing "where am I" concept, physical side only |

### 2.2 The hard gaps

1. **Postgres has zero tenancy.** All ~35 tables in `src/persistence/postgres/migrations.ts` (memories, contacts, concerns, scheduler, scratchpad, wiki chunks, model usage…) lack any `companion_id` column. Worse, `internal_state_snapshots` uses a hardcoded `'current'` primary key (`internal-state-store.ts:15,37-63`) — two companions on one DB would overwrite each other's internal state every turn. Several unique constraints (e.g. `contact_channel_ids (channel, channel_user_id)`) would collide across companions.
2. **Gateway is single-peer.** `resolveReadyRpcClient` returns the *first* ready agent (`server.ts:420-435`); inbound Discord messages `notifyAll` to *every* connected agent (`channel-surfaces.ts:88-91`); RPC correlation params carry no companionId (`protocol.ts:56-66`). A second agent attaching today would silently contend and receive everything.
3. **No channel→companion routing.** `channels.json` has no companion dimension; one gateway wires one Discord + one Telegram adapter.
4. **Garden terminates in one live runtime.** The admin surface is closures over a single `AgentCoreRuntime`'s in-memory objects via one Unix socket (`src/app/agent/admin-surface.ts:67-127`, `operator-surface.ts:44-246`). Every `/api/admin/*` route family implicitly means "the one companion." Auth is a single shared bearer token, no authorization dimension.
5. **Owner-config files are system-global singletons.** `models.json`, `settings.json`, `capability-tier.json`, `trust-policy.json`, `charge-policy.json` etc. live in `systemDataDir` per the owner-file contract (`settings-contract-guard.ts`, `startup-owner-files.ts`). "Own models per companion" needs a scoping decision here.
6. **Locations are planned but not yet built — and planned single-companion.** [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (synced 2026-07-08, epic `psfn-framework-vinz`) fully specifies the place/affordance model, but no locations code exists in `src/` yet, and the plan models one companion: `places.json` is a per-deployment soft-registry, presence/emanation state is per-companion, and nothing answers "which *other companions* are in this place." The multi-companion deltas are additive (see W5) — the locations model itself needs no rework.
7. **No stable companion identity for cross-cluster auth.** Contacts key on channel user IDs; the identity-link flow signs channel↔channel links but there is no companion↔companion handshake primitive. Trust is unidirectional/local (my trust of peer; no model of peer's trust of me).
8. **Backups are single-tree + whole-DB dump.** `backups/service.ts:364-433` snapshots one companion tree, one system tree, one `pg_dump`; no per-companion restore unit.

## 3. Architecture decision (recommended)

### 3.1 Topology: N agent processes behind one gateway

**Recommended: keep one `SubstrateAgent` per OS process; run N agent processes, each with its own `COMPANION_ID` + `COMPANION_DATA_DIR` + card, all connecting to one gateway over the existing socket protocol.**

Rationale:

- Per-companion state (sessions, memory faculties, scheduler, heartbeat, emotion, self-model, shard manager, tool registry, event bus) is *already* isolated by the process boundary + `companionDataDir`. Multiplexing N companions inside one agent process would require threading a companion key through every store builder in `composition.ts` — a rewrite with no offsetting benefit.
- The gateway's per-connection RPC maps (`server.ts:113-114`) make companion-addressed routing a contained extension, and the gateway keeps sole ownership of secrets/egress — companions stay isolated from each other's credentials by construction, which matters once companions have different trust/privacy profiles.
- Failure isolation: one companion crashing or being upgraded doesn't take down siblings.

Costs to accept: N × process memory footprint; the launcher becomes a supervisor for N agents; k8s/pod topology grows one container per companion (this fits the existing k3s deployment model in `psfn-live-ops`).

### 3.2 Database: one Postgres, schema-per-companion + one shared schema

Two viable options; recommendation is **(B)**.

- **(A) Column tenancy** — add `companion_id` to all ~35 tables, rework unique constraints and every query, change `internal_state_snapshots` PK. Pro: single schema, easy cross-companion queries. Con: invasive migration across every store, high regression risk, per-companion backup requires row-filtered dumps.
- **(B) Schema-per-companion** — each agent process gets its Pool with `search_path = companion_<id>`; migrations run per schema, **queries don't change at all**. A separate `shared` schema holds world data (locations, shared wiki chunks, world state, ICP outbox). Pro: near-zero code churn in stores, hard isolation (no cross-companion leakage possible even under bugs), per-companion `pg_dump --schema` restore falls out naturally, `internal_state_snapshots.'current'` singleton becomes harmless. Con: N schemas to migrate/operate; deliberate cross-companion queries (Garden fleet views) must go through the shared schema or explicit fan-out.

The isolation property aligns with "fail closed" and with the privacy stance (a companion's memories are theirs); shared-world data is *deliberately* placed in the shared schema rather than accidentally co-mingled. Single-companion default mode keeps today's `public` schema untouched.

### 3.3 Filesystem: `companion-data/<companionId>/` roots

Generalize `resolveRuntimePathLayout` (`layout.ts:224-340`): under the multi-companion flag, each agent's `companionDataDir` becomes `<root>/companion-data/<companionId>`. The overlap guards (`assertNoDuplicateRoots`/`assertNoOverlappingRoots`, `layout.ts:147-181`) generalize to validate N companion roots against each other and the system root. All ~50 path helpers are untouched.

### 3.4 The flag

`multiCompanion` is **process wiring / topology selection → `.env` scope** per the config model (like layout mode selection), not a JSON owner setting: e.g. `PSFN_MULTI_COMPANION=1` plus a `companions.json` **new system-owned owner file** enumerating the fleet:

```jsonc
// system-data/companions.json (only read when flag is on)
{
  "companions": [
    {
      "companionId": "aria",
      "companionDataDir": "companion-data/aria",
      "characterCardPath": "companion-data/aria/companion.json",
      "modelsOverride": null,           // optional per-companion models override file
      "postgresSchema": "companion_aria"
    }
  ]
}
```

Fail closed: flag on + missing/invalid `companions.json` = refuse to start; flag off = `companions.json` must be absent (or ignored with a startup warning — decide; lean refuse, consistent with owner-file strictness).

## 4. Workstreams

Ordered by dependency; W1–W3 are the substrate, W4–W5 make it operable, W6–W7 are the experience.

### W1 — Gateway multiplexing (substrate)

- Add `companionId` to `gateway.client.identify` (`server.ts:574-587`) and to `GatewayCorrelationParams` (`protocol.ts:56-66`).
- Replace first-ready-agent resolution with a `Map<companionId, connection>`; make `notifyAll` companion-addressed (`notifyOne` already exists, `server.ts:347`).
- Channel→companion routing table: add an optional `companionId` per channel/account entry in `channels.json`; gateway resolves inbound `discord.message`/`telegram`/API/voice traffic to exactly one companion. Flag off ⇒ current broadcast behavior, byte-for-byte.
- Launcher: `start-gateway-agent.sh` grows a supervisor mode reading `companions.json` and spawning one agent process per entry (each with its scrubbed env).
- Multiple adapter accounts (e.g. two Discord bot tokens) via the existing `ChannelAdapterRegistry` keyed instances — stretch, not required for v1 (one account, channels partitioned by routing table, is enough to start).

### W2 — Postgres tenancy (substrate)

- Per-agent Pool with `search_path` (small change in `src/persistence/postgres.ts` + `runtime-factory.ts:61-98` accepting a schema).
- Migration runner runs per companion schema; `shared` schema gets its own migration chain.
- Move nothing in single-companion mode. Provide a cutover helper (pattern: `src/app/maintenance/migrate-persistence-layout.ts`) that adopts an existing single-companion DB as `companion_<id>` schema (or leaves it in `public` as the flagship companion — decide; lean: leave in place, new companions get new schemas, avoids risky data movement).
- Backups: N companion-tree snapshots + per-schema dumps + one shared-schema dump + one system tree (`backups/service.ts:79-146` already models sources as a list).

### W3 — Config scoping (substrate)

- Per-companion owners: `companion.json` (card — already per-companion), and *optional* per-companion `models.json` override resolved before the system one (agent-side load in `startup-context.ts:140,145`; gateway keeps the global provider registry and secrets — per-request model hints already carry model+provider).
- Stays system-global: `providers.json` (secrets are gateway property), `channels.json` (gateway routing), `backup.json`, `scheduler.json` defaults (per-companion scheduler *state* is already in companion storage).
- Decide per-companion vs global: `settings.json`, `capability-tier.json`, `trust-policy.json`, `charge-policy.json` (see Open Questions — lean: per-companion overrides layered on system defaults, same guard machinery, new owner map entries).
- `settings-contract-guard.ts` / `startup-owner-files.ts` learn the "companion-scoped owner" tier.

### W4 — Garden multi-companion (operability)

Answer to the open question: **yes, one Garden can serve many companions — as a proxy fleet-router, not by making the admin contract multi-tenant.**

- Garden's `GardenAdminTransportProxy` (`operator-surface.ts:47`) becomes a map of `companionId → admin transport endpoint` (each agent process already exposes its own admin socket via `startOptionalAdminTransportServer`). Routes gain a scope: `/api/admin/c/<companionId>/...`; unscoped routes keep working when the flag is off.
- UI: `admin-ui/src/lib/api/client.ts` is the single HTTP chokepoint — inject the active companion id there. Add a companion switcher; the module-level rune singletons (`auth.svelte.ts`, `companion.svelte.ts`, telemetry socket) either become keyed by companion or the app remounts on switch (**remount is the cheap correct v1**).
- Add a small fleet dashboard (list companions, up/down, fatigue/charge posture) fed by the gateway's connection registry.
- Auth stays single-operator shared token for v1; per-companion authorization is explicitly out of scope (noted as future work).

### W5 — Multi-companion locations + shared world wiki (experience)

**Base model is [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (epic `psfn-framework-vinz`), which is single-companion. Do not re-model locations here — layer these deltas on it:**

- **`places.json` becomes fleet-shared, naturally.** It's a system-owned soft-registry loaded from `dataDir` (locations doc A1); in multi-companion mode all agent processes load the same file, so all companions share one world map for free. Delta: none required for v1 — flag a follow-up if companions ever need private places.
- **Cross-companion presence.** The locations plan makes presence/emanation per-companion state (`active-emanation-state.ts`, durable `situated` self-model state, B3). Nothing can answer "who *else* is here." Add a `companion_presence` table in the **shared** schema (`companionId → siteId/placeId, kind: physical|virtual, since`), written by each agent on emanation/`world move` changes, read by the situated-context block (B1) so "what do I perceive here" includes co-present companions, and watched by the gateway for co-location events. This is the one genuinely new persistence surface.
- **Virtual navigation for companions.** The locations doc's `world` tool covers `perceive/list/control`. Companions inhabiting virtual places need a `move` action (navigate to an adjacent/known place). Physical presence stays satellite-bound per Decision 6 (static bindings, no auto-rebinding) — `move` applies to `kind: 'virtual'` places only in this sprint.
- **Co-location venue = the MUD-over-Discord testbed.** Locations doc A3 already puts virtual places on Discord channels. Multi-companion co-location v1: two companions whose presence is in the same virtual place are both routed (W1 routing table) into that place's channel — the fatigue `companion_room` channel classification then applies natively. No new venue machinery needed for the demo.
- **Shared vs personal wiki:** coordinate with the shared-world wiki MVP bead **`psfn-framework-i5s2`** (referenced by locations doc A4) rather than inventing scope semantics here. The shape: add a scope dimension to `WikiDocumentMetadata` (`personal` | `shared_world:<siteId>`); personal wiki stays in `companion-data/<id>/knowledge/wiki/`; shared-world wiki lives in shared storage (shared schema chunks + system-owned markdown tree, seeded by A4's `places.json`→wiki publication). `resolveWikiRetrievalPlan` (`retrieval.ts`) gains scope filtering keyed off **current place/site**: personal scope always + the shared scope(s) bound to where the companion presently is. Moving between areas (physical or virtual) swaps which shared scope is queried — personal wiki untouched by construction. The existing `filterPersonalFactProposals` boundary filter (`sleeptime-wiki-pass.ts:302-342`) becomes the write-side guard for anything a companion proposes into shared scope, layered under whatever ACL/review gates `psfn-framework-i5s2` defines.

### W6 — Inter-companion protocol (experience)

Composition (all pieces exist; the work is wiring, not invention):

- **Peer = Contact.** Each remote companion is a contact with `isMachineIntelligence: true`, `relationshipType: 'ai_companion'`, and an operator-assigned (later: earned) trust tier. Disclosure runs through the existing `evaluateMemoryPolicy` / context-envelope machinery — same privacy settings as everyone else, as required.
- **Same-cluster transport:** a new `companion` `ChannelAdapterPort` backed by the gateway. A virtual room (from W5 co-location) materializes as a channel (`channelId` = `companion-room:<locationId>`); the gateway routes messages among the companions present. Because it's a normal channel through the normal turn pipeline, **fatigue is enforced with zero new mechanism**: `evaluateFatigueForTurn` (`turn-execution-runtime.ts:406-432`) charges MI↔MI turns against the `companion_room` budgets, soft-exhaustion injects the wrap-up alert in the companion's own voice, hard exhaustion suppresses the model call. Loop prevention is the existing invariant: bot-triggered-by-bot costs 1, human participation resets to free.
- **Cross-cluster transport:** reuse the satellite backplane's authenticated claim pattern (client-cert fingerprint + capability tokens). A remote cluster's companion appears as an authenticated peer endpoint; messages carry a lineage-style provenance envelope (`coreCompanionId`, origin cluster, signature). Fatigue is charged on the **receiving** side before dispatching the peer-triggered turn (the one genuine new hook: the backplane inbound path must call the same fatigue evaluation the turn pipeline uses — verify it does once ICP messages arrive as channel turns; if they do, this is free too).
- **Companion identity:** mint a stable companion identity (id + keypair) so cross-cluster peers aren't just channel user IDs. Extend the existing `ContactIdentityLinkVerification` (nonce+signature+expiry) pattern into a companion↔companion handshake.
- **Nothing a peer asserts is trusted:** any memory/artifact/wiki-edit a peer companion offers goes through a fold-review-style quarantine→approve pipeline (reuse `ShardFoldReviewController` shape) rather than direct writes. Conversation itself is just conversation (normal L0/L2 extraction on each side, each companion remembers the exchange as *their own* lived experience — this is correct and needs no gating beyond normal channel privacy).
- **Co-location triggers:** entering a place where another companion is present emits an event (event bus, from the shared `companion_presence` surface in W5) that can open/join that place's conversation channel; free-time/outreach scheduler lanes can choose to visit places — this is where "enjoying their own time" lives, governed by run-charge lane quotas (`charge-policy.seed.json` background lane) so world-wandering is budgeted too.

### Sequencing

```
W1 gateway multiplexing ──┬─► W4 Garden fleet routing
W2 postgres tenancy ──────┤
W3 config scoping ────────┘
        │
        ▼
W5 locations + shared wiki ──► W6 ICP same-cluster ──► W6 ICP cross-cluster
```

W1–W3 land behind the flag with parity tests proving flag-off is byte-identical. W5 depends on the locations epic's A1/A2 (places registry + bindings) and coordinates with the shared-wiki bead `psfn-framework-i5s2`; the two sprints can run in parallel until the co-presence integration point. W6 same-cluster can start as soon as W1 exists (two companions, one hand-made room channel) — that's also the earliest demo: *two companions on one gateway holding a fatigue-bounded conversation*.

## 5. Open questions

1. ~~Where is the sprint-10 locations doc?~~ **Resolved 2026-07-08:** synced as [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (epic `psfn-framework-vinz`); W5 rewritten as deltas on its model. Remaining sub-question: sequencing between the two epics — does multi-companion substrate (W1–W3) land before, after, or interleaved with the locations MVP?
2. **Postgres tenancy: schema-per-companion (recommended) or column tenancy?** §3.2 argues for schemas; needs sign-off since it shapes W2, backups, and Garden fleet views.
3. **Does the flagship companion's existing data stay in `public` schema, or migrate into `companion_<id>`?** Lean: stays put (zero-risk), new companions get schemas. Cost: one special case in the fleet config.
4. **Which owner files become per-companion?** Card and models-override are clear. `trust-policy.json` and `charge-policy.json` per companion would let companions have different social temperaments — desirable? `capability-tier.json` per companion (different tool tiers per companion) — desirable? Each adds guard/Garden surface.
5. **One shared channel account vs per-companion accounts?** v1 routes channels of one Discord/Telegram account to companions via the routing table. Distinct bot identities per companion (multiple tokens) is more legible to humans but multiplies gateway adapter instances — v1.5?
6. **Fatigue accounting for ICP sends.** Receiving side charging is the loop-breaker (both parties charge their own budget when responding to an MI trigger — symmetric and sufficient?). Do we *also* want a send-side cost in the run-charge lanes for initiating visits/outreach? Lean yes: free-time lane already has quotas; visiting a location = background lane spend.
7. **Who writes the shared world wiki?** Operator-only at first? Companions via quarantine→operator-approve (fold-review pattern)? Or companion-autonomous within their "home" space and quarantined elsewhere? Lean: operator seeds; companion proposals quarantined; revisit after observing.
8. **World state authority.** The locations plan needs no arbiter (one companion, its own presence state). Multi-companion co-presence does: which process arbitrates virtual `move`s and emits co-location events? Lean: gateway hosts a small world service reading/writing shared-schema `companion_presence` (it already owns cross-companion routing); agents call `world move` via RPC. Alternative: a fourth process. Cross-cluster worlds (one monastery spanning two clusters) — v1 says a world lives on one cluster and remote companions visit over ICP.
9. **Garden auth over N companions.** Single operator token for v1 is assumed. Is per-companion operator delegation (different humans administer different companions) in scope for this sprint? Lean: no.
10. **Companion identity format.** Stable id + keypair per companion for cross-cluster handshakes — self-signed and TOFU-pinned (satellite pattern) or operator-exchanged out of band? Lean: reuse satellite claim/fingerprint pattern, operator-exchanged.
11. **Scheduler/heartbeat contention.** N companions × heartbeat/free-time lanes on one gateway = N × background LLM traffic. Is a fleet-level charge ceiling needed (gateway-side), or are per-companion lane quotas sufficient? Lean: per-companion quotas first, observe, add a gateway ceiling if needed.
12. **Wyoming/voice in multi-companion mode.** Voice surfaces bind gateway-side; which companion answers a given Wyoming satellite? Presumably the routing table covers `siteId → companionId` — confirm the voice stream path threads companion routing (it already carries a `companionId` tag: `server.ts:415-416`).

## 6. Risks

- **Flag-off regression risk** — every W1/W2 change must be provably inert when the flag is off. Mitigation: parity tests as part of each PR (pattern already used for runtime-mode parity), plus `verify:settings-contract` extension for the new owner file.
- **Epic collision with `psfn-framework-vinz`** — the locations epic touches the same seams (satellite registry, presence, situated context, wiki). Mitigation: W5 is defined strictly as deltas on that epic's model; shared-schema `companion_presence` and wiki scope are the only new surfaces, and both are additive.
- **Cross-companion privacy leaks via shared surfaces** — shared schema, shared wiki, Garden fleet views are the new leak surfaces. Mitigation: schema isolation for personal data (nothing personal in shared schema, ever), `filterPersonalFactProposals` on all shared-wiki writes, fold-review quarantine for peer assertions.
- **Fatigue bypass** — any ICP path that doesn't enter the standard turn pipeline silently skips loop protection. Mitigation: hard rule — peer messages are channel turns, no side-channel dispatch; add a test that an ICP message with no human participation exhausts and suppresses (extend `two-companion-loop.test.ts` to the real channel).
- **Operational blast radius** — one Postgres, one gateway = shared fate for N companions. Accepted for this sprint (it's the stated topology); per-schema backups keep restore blast radius per-companion.

## 7. Immediate next actions

1. Sign off §3 architecture decisions (topology, schema-per-companion, flag shape, flagship-data stays in `public`).
2. Decide sequencing against epic `psfn-framework-vinz` (locations) — W1–W3 are independent of it and can start now; W5 waits on its A1/A2 and coordinates with `psfn-framework-i5s2` (shared-world wiki).
3. File the W1–W6 epic + issues in beads (from a checkout that can reach the beads server — `bd` has no database in this sandbox).
4. Spike: two agent processes against one gateway with a hand-edited routing table — validates W1's shape in days and yields the first two-companion conversation demo.
