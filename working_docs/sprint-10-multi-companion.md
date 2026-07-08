# Sprint 10 — Multi-Companion Substrate

Status: planning v2 (2026-07-08). v1 was produced from a five-way codebase survey (persistence, composition, shards/fatigue/trust, Garden, locations/wiki); this revision folds in the **2026-07-08 design review decisions**. Where the review overrode a v1 lean, the override is marked. File refs are as of `main` @ `277e8084`.

Companion doc: [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (epic `psfn-framework-vinz`) defines the location/world-control surface for a **single** companion — the place/affordance model (`places.json`), situated context, the `world` tool, presence ingestion, and the MUD-over-Discord virtual testbed. This doc plans the **multi-companion substrate** and layers multi-companion semantics (co-presence, companion↔companion conversation, shared world wiki) on top of that model. Terminology here follows the locations doc: **site / place / affordance / presence** — not "rooms" (except where "room" means a conversation channel, which is exactly what it is — see the guiding model).

## 1. Vision and guiding model

Move from "1 companion core, 1 garden, 1 gateway, 1 Postgres = one companion" to:

- **One gateway, one database, many companions.** Each companion is distinct — not a shard. Own durable-object storage, own L0 session history, own memory, own character card, own config, potentially own models.
- **Flag-gated, not default.** Single-companion remains the default topology; multi-companion is an explicit opt-in. Everything must work with the flag off; with the flag on, adding companions must also just work.
- **Shared world, personal selves.** Companions share a world-info wiki and a locations model, while keeping personal wikis and personal memory strictly separate. World info swaps as a companion moves between areas (physical or virtual) without touching personal data. Memories and emotions always stay per-companion.
- **Inter-companion communication** governed by the fatigue system (loop prevention) and the same trust/privacy machinery as every other contact.

**Guiding model (review §1): the substrate is a MUD.** Everything is a channel-based chat core; avatars in virtual spaces and hardware devices with screens in physical spaces are *presentation layers* on top of it. A companion on a physical device is an **emanation** bound to that specific device — present only on that screen while bound. Moving between rooms ≡ moving between channels. The multi-channel/multi-user infrastructure already built for the group Discord context is the foundation, and cross-channel information sharing is already gated by privacy, relationship, and trust.

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
| Authenticated cross-node transport | satellite backplane (`src/channels/backplane/satellite-registry.ts`, claim headers + client-cert fingerprints, capability tokens) | Foundation for intra-cluster companion auth (shared signing certs) |
| Channel adapter port abstraction | `src/channels/backplane/types.ts:66-90` (`ChannelAdapterPort`) | A companion-to-companion channel can be "just another channel," inheriting the whole turn pipeline (fatigue, trust, context envelope) |
| Wiki system (= the world-info system) | `src/faculties/wiki/` — store, pgvector projection, retrieval plan with token caps, nightly `SleeptimeWikiPass`, `wiki` tool, Garden UI route | Mature. Charter Law 32 / §6.26: wiki is world knowledge, explicitly NOT lived memory (L0/L0.1/L2) |
| Personal/world boundary filter | `sleeptime-wiki-pass.ts:302-342` (`filterPersonalFactProposals`) | Deterministic guard that already rejects personal facts leaking into world knowledge — exactly the shared-vs-personal boundary we need |
| Presence/emanation model | `src/core/agent/presence-metadata.ts`, `active-emanation-state.ts`, `ambient-presence.ts`; satellite `staticLocationLabel`/`siteId` | Models which device/channel a companion is active on — the nearest existing "where am I" concept, physical side only |

### 2.2 The hard gaps

1. **Postgres has zero tenancy.** All ~35 tables in `src/persistence/postgres/migrations.ts` (memories, contacts, concerns, scheduler, scratchpad, wiki chunks, model usage…) lack any `companion_id` column. Worse, `internal_state_snapshots` uses a hardcoded `'current'` primary key (`internal-state-store.ts:15,37-63`) — two companions on one DB would overwrite each other's internal state every turn. Several unique constraints (e.g. `contact_channel_ids (channel, channel_user_id)`) would collide across companions. Review confirmed this also bites **shards** — the assumption that shard IDs already made fold-out/fold-in safe against the same database turned out to be false.
2. **Gateway is single-peer.** `resolveReadyRpcClient` returns the *first* ready agent (`server.ts:420-435`); inbound Discord messages `notifyAll` to *every* connected agent (`channel-surfaces.ts:88-91`); RPC correlation params carry no companionId (`protocol.ts:56-66`). A second agent attaching today would silently contend and receive everything.
3. **No channel→companion routing.** `channels.json` has no companion dimension; one gateway wires one Discord + one Telegram adapter.
4. **Garden terminates in one live runtime.** The admin surface is closures over a single `AgentCoreRuntime`'s in-memory objects via one Unix socket (`src/app/agent/admin-surface.ts:67-127`, `operator-surface.ts:44-246`). Auth is a single shared bearer token, no authorization dimension.
5. **Owner-config files are system-global singletons.** `models.json`, `settings.json`, `capability-tier.json`, `trust-policy.json`, `charge-policy.json` etc. live in `systemDataDir` per the owner-file contract (`settings-contract-guard.ts`, `startup-owner-files.ts`).
6. **Locations are planned but not yet built — and planned single-companion.** [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) fully specifies the place/affordance model, but no locations code exists in `src/` yet, and nothing answers "which *other companions* are in this place." The multi-companion deltas are additive (see W5).
7. **No stable companion identity for cross-cluster auth.** Contacts key on channel user IDs; there is no companion↔companion handshake primitive. (Cross-cluster is now deferred — see §7 — but intra-cluster identity is still needed.)
8. **Backups are single-tree + whole-DB dump.** `backups/service.ts:364-433` snapshots one companion tree, one system tree, one `pg_dump`; no per-companion restore unit.

## 3. Architecture decisions (✅ approved in review)

### 3.1 Topology: N agent processes behind one gateway — **approved**

One `SubstrateAgent` per OS process; N agent processes, each with its own companion ID + data dir + card, all connecting to one gateway over the existing socket protocol. Per-companion state is already isolated by the process boundary; the gateway keeps sole ownership of secrets/egress; failure isolation is free. Costs accepted: N × process memory, supervisor launcher, one container per companion on k3s.

### 3.2 Identity & database — **approved, with overrides**

- **Companion ID = UUID** (review §2), consistent with the UUID scheme used everywhere else. Every companion — including ones entering the system from elsewhere — carries its own companion ID.
- **One Postgres schema per companion + one `shared` schema** (option B from v1) — **approved**. Each agent process gets its Pool with `search_path = companion_<uuid>`; migrations run per schema; **queries don't change at all**; per-schema `pg_dump` gives per-companion restore; the `internal_state_snapshots.'current'` singleton becomes harmless. The `shared` schema holds world data (locations/presence, shared wiki chunks, world state).
- **Shard alignment** (review §2): shards reuse the parent's ID namespace (`<companionId>.1`, `.2`, …) and get their own derived schema, so shards share the database without colliding with the main. This makes the multi-companion tenancy fix *also* the shard-collision fix — one mechanism, two problems.
- **Flagship migrates off `public`** — **override of v1 lean** (v1 said "leave it in place"). The flagship companion's data moves into its own companion-ID schema. Rationale: it resolves the sharding issues too and keeps the difference between single- and multi-companion setups minimal. Cutover helper follows the `migrate-persistence-layout.ts` pattern.

### 3.3 Filesystem: `companion-data/<companionId>/` roots — **approved**

Companion ID becomes a route/directory; all per-companion data lives under the companion's own directory. Generalize `resolveRuntimePathLayout` (`layout.ts:224-340`); the overlap guards (`layout.ts:147-181`) validate N companion roots against each other and the system root. All ~50 path helpers untouched.

### 3.4 The flag

`PSFN_MULTI_COMPANION=1` (`.env` scope — process wiring/topology selection) plus a `companions.json` system-owned owner file enumerating the fleet (companionId, data dir, card path, postgres schema, per-companion selections — see W3). Fail closed: flag on + missing/invalid `companions.json` = refuse to start; flag off + `companions.json` present = refuse to start (owner-file strictness). Everything works flag-off byte-identically; flag-on, adding a companion entry just works.

## 4. Workstreams

### W1 — Gateway multiplexing (substrate; **primary repair area** per review §5)

- Add `companionId` to `gateway.client.identify` (`server.ts:574-587`) and to `GatewayCorrelationParams` (`protocol.ts:56-66`). Replace first-ready-agent resolution with a `Map<companionId, connection>`; make `notifyAll` companion-addressed (`notifyOne` exists, `server.ts:347`).
- **Strict fail-closed routing (review §5):** a response for Companion A must return to Companion A, never B — crossover would leak secrets between companions. Any routing ambiguity fails closed and **alarms loudly** (telemetry + operator surface). Trust and privacy are the most critical parts of the system; add explicit crossover tests.
- **Concurrency:** the gateway (with LiteLLM) must handle high concurrent load — two parallel in-flight requests must each land back on the correct companion. Correlation params carry companionId end-to-end; no shared mutable "current requester" state anywhere.
- **Channel→companion routing table** in `channels.json`: every channel/account entry maps to exactly one companion. Room/chat membership is entirely per companion — companions may share rooms, occupy different room sets, and DM the same or different people.
- **Per-companion Discord tokens (review §5 — upgraded from v1 "stretch" to required):** one Discord bot identity per companion via keyed `ChannelAdapterRegistry` instances; gateway holds all tokens; multi-threaded distinct conversations with correct per-companion routing.
- Launcher: `start-gateway-agent.sh` grows a supervisor mode reading `companions.json` and spawning one agent process per entry (each with its scrubbed env).

### W2 — Postgres tenancy + backups (substrate)

- Per-agent Pool with `search_path` (`src/persistence/postgres.ts` + `runtime-factory.ts:61-98` accepting a schema); migration runner runs per companion schema; `shared` schema has its own migration chain.
- Flagship cutover helper: adopt the existing `public`-schema data into `companion_<uuid>` (decision §3.2). Shard schemas derive from the parent companion ID.
- **Backups (review §11): one companion, one backup is the default.** Each companion in a shared DB/cluster saves as its own separate backup with its own durable goods, so a single character can be moved to another cluster as a slice. Whole-database **group backup** (companions as a family) available as an option. **Restore mirrors one-to-one**; restore functions still need build-out (tracked in §7 follow-ups).

### W3 — Config scoping (substrate)

Decided in review §3–§4:

- **Per-companion:** capabilities (`capability-tier.json`), trust (`trust-policy.json`), charge (`charge-policy.json`), personality/character files, settings — assigned per companion. New "companion-scoped owner" tier in `settings-contract-guard.ts` / `startup-owner-files.ts`, same guard machinery.
- **System-global:** `providers.json` (secrets are gateway property), `channels.json` (gateway routing), `backup.json`, and the **master models registry**: one global models file on the gateway lists every model available to the system across providers — the registry is the same for everyone. **Which** models a companion uses for which functions lives in that companion's own settings (most share the same models; some use better ones, some local ones).
- **Hard files remain the source of truth.** Open design point (review §3): optionally mirror some per-companion config into the DB for live read, writing back to files only on actual updates — keeps hydrating a companion on a different substrate simple (files only, no full DB needed). Not required for v1.
- Capability tiers (review §10): per-companion charge/trust/tier supports intentionally-limited "hang-out" companions (middle tier, limited self-modification, no full tool set) up through the existing autonomy tier. A **"management" tier above autonomy** (acting on *other* companions' settings via gateway/Garden APIs — the adult-and-child guardrail case) is explicitly deferred (§7); it needs more thought and strictly higher gating.

### W4 — Gardens (operability) — **decision changed in review §6**

**One Garden per companion** — override of v1's fleet-router recommendation (UID-scoped routes + reworked UI data flow judged more complex than it's worth right now). Each companion gets its own Garden surface: today's operator-process shape × N, each bound to its companion's admin socket, ports/paths assigned from `companions.json`.

**Add: a Garden fleet view** — an overall health view of all companions in one cluster (up/down, fatigue/charge posture), fed by the gateway's connection registry, linking out to each companion's Garden. Hosting lean: a thin page served by the gateway/operator side (remaining question Q-B).

Auth stays single-operator shared token; the operator is admin and can see everything (review §13).

### W5 — Locations, rooms & shared world wiki (experience)

**Base model is [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md). Per review §14: anything that belongs to location is location work; multi-companion feeds off it and layers deltas.** Room mechanics decided in review §7:

- **Rooms/environments are channels** with their own room ID; the room ID is part of a world ID. The session holds all info about who is present — exactly like existing Discord group rooms. Applies identically to virtual environments and physical ones (your house is one channel; virtual rooms behave like separate Discord rooms).
- **Entry event:** a companion entering a room receives a **system-only message**: room ID, surroundings, who else is present.
- **Public rooms:** participants see full conversation history.
- **Private/invite rooms are time-gated:** someone joining later has no evidence of what happened before their join, and **memory generation is gated by join/exit times**. A private conversation stays private unless the participants choose to share it. (Implementation home: locations/session work — context manifests + session membership windows; the L0-extraction-respects-presence-intervals requirement is new and flagged in Q-C.)
- **Navigation:** retro navigation via a top-level tool — the locations doc's `world` tool grows a `move` action that describes the environment and lists available rooms. Physical presence stays satellite-bound (see W7); `move` applies to virtual places.
- **Cross-companion presence:** `companion_presence` in the **shared** schema (`companionId → siteId/placeId, kind: physical|virtual, since`), written on emanation/`move` changes, read by the situated-context block so "what do I perceive here" includes co-present companions; the durable authority behind the per-session presence view.
- **Shared world wiki (review §8): world-info authority is separate from the companion core.** Companions *read* shared world info and *propose* writes — they never write directly. A **caretaker** layer (gateway-managed or a dedicated meta/assistant process) owns writes: deduplication, rebalancing, wiki rewrites, cleanup — mostly deterministic, some LLM-assisted. Flow: companion suggests entry → dedup → **operator approves** (human-in-the-loop) → independent background process keeps the space clean and evolving. The toaster test: tell one companion "I bought a new toaster, it's in the kitchen next to your satellite" → becomes world info → a second companion who wasn't present reads it later and knows. **No personal/memory information in the wiki, ever** — the caretaker/scrub layer enforces it (`filterPersonalFactProposals` is the existing deterministic guard) and drops companion-suggested entries containing personal info. Personal wiki stays in `companion-data/<id>/knowledge/wiki/`; scope filtering in `resolveWikiRetrievalPlan` keys off current place/site, so moving between areas swaps the shared scope without touching personal wiki. Coordinate with shared-world wiki MVP bead `psfn-framework-i5s2`. **Cross-cluster world sync: out of scope — one world = one cluster** (review §8, deferred in §7).

### W6 — Inter-companion communication (experience)

Approved in review §9/§15/§16 ("companion protocol — approved, looks very good"). Composition:

- **Peer = Contact.** `isMachineIntelligence: true`, `relationshipType: 'ai_companion'`, operator-assigned trust tier. Disclosure runs through the existing `evaluateMemoryPolicy` / context-envelope machinery — same privacy settings as everyone else. Track MI vs. not rigorously; there shouldn't be fatigue bypasses, but stay alert to that risk (review §15).
- **Intra-cluster trust is automatic:** companions on one cluster are siblings — same websocket + certificate-based authentication via shared signing certs.
- **Two distinct shapes (review §9):**
  - **IPC — one-to-one direct channel** (the SMS/DM/phone-call analogue). A companion in one room can IPC a companion elsewhere. Because fatigue keys on `{companion, peer, channelId, day}`, the DM channel has its own budget — the visitor is *not* fatigued by the room's activity (and DM loops are still independently bounded). What happens in the room doesn't leak into the DM by default; the trust matrix governs any sharing and skews toward keeping private conversations private.
  - **Ad-hoc API chat rooms — many-to-many.** Several companions joined through the API form a session behaving as one chat room, using regular API chat with fatigue and everything else. So three companions can chat in a room on their room fatigue while a fourth IPCs one of them without touching that room's budget.
- Both shapes are ordinary channels through the normal turn pipeline, so **fatigue is enforced with zero new mechanism**: MI↔MI turns charge `companion_room` budgets, human participation is free, hard exhaustion suppresses the model call.
- **Nothing a peer asserts is trusted:** peer-offered memories/artifacts/wiki-edits go through fold-review-style quarantine→approve (reuse `ShardFoldReviewController` shape). Conversation itself is just conversation — normal L0/L2 extraction on each side.
- **Co-location triggers:** entering a place where another companion is present emits an event (from shared `companion_presence`) that can open/join that place's channel; free-time/outreach lanes can choose to visit places, budgeted by run-charge lane quotas.
- **Cross-cluster direct communication: deferred** (§7). When it comes: a different, higher trust model (shared-key vs OAuth-style open), possible DM key-exchange + secondary TCP-port validation, and the **gateway as arbiter** of all cross-cluster connections since traffic leaves the environment. Operator approval is required out-of-band before cross-cluster comms occur; tokens revocable at any time by companion or operator (review §13). The gateway will eventually host a **cognitive security firewall** (injected-command inspection, dangerous-actor channel cut) — future work; until then trust anchors on gateway routing + shared signing certs.

### W7 — Voice & satellite binding (review §12)

- Voice routes exactly like text: one-to-one to the specific endpoint/app/Discord-voice-chat the companion is generated on, even with multiple companions doing TTS/STT in one voice chat. (Voice stream path already carries a `companionId` tag: `server.ts:415-416` — verify it threads the W1 routing.)
- **One companion per satellite, hard rule.** One emanation to one physical device — never two companions on one device (or one app). A satellite device + its ID act as a channel carrying its location info/surroundings; once bound, the companion's emanation speaks only through that device. If the operator moves rooms, the companion moves and binds to that room's device; future voice forwards to wherever the companion currently emanates.
- The Wyoming-based voice-chat-to-satellite approach is likely not final; a voice subsystem rewrite is a tracked follow-up (§7).

### Sequencing (review §14)

**Build locations first.** Any schema work needed now goes into the locations work. Multi-companion modifications to location land afterward; once a threshold of locations work is complete, the two run in parallel.

```
locations epic (psfn-framework-vinz) ──► threshold ──┬─► locations continues
                                                     └─► multi-companion:
W1 gateway multiplexing ──┬─► W4 Gardens + fleet view
W2 postgres tenancy ──────┤
W3 config scoping ────────┘
        │
        ▼
W5 location deltas + shared wiki ──► W6 ICP intra-cluster        (cross-cluster deferred)
```

W1–W3 land behind the flag with parity tests proving flag-off is byte-identical. Earliest demo remains: two agent processes on one gateway holding a fatigue-bounded conversation in one hand-made room channel.

## 5. Decision log (from the 2026-07-08 review)

All twelve v1 open questions are resolved except the four in §6:

| # | v1 question | Resolution |
|---|---|---|
| 1 | Sequencing vs locations epic | Locations first; schema work goes into locations; split parallel after threshold (review §14) |
| 2 | Schema-per-companion vs column tenancy | **Schema-per-companion approved**; + shard schema reuse via `<companionId>.N` (review §2) |
| 3 | Flagship stays in `public`? | **No — migrate flagship** to its companion-ID schema (override; also fixes sharding) |
| 4 | Which owner files per-companion | Capabilities, trust, charge, personality, capability tier, settings per companion; master models registry + providers/channels/backup global (review §3–4) |
| 5 | Shared vs per-companion channel accounts | **Per-companion Discord tokens, required** (review §5) |
| 6 | Fatigue accounting for ICP | Approved as suggested; IPC (DM) vs room budgets are naturally separate channels (review §9/§15) |
| 7 | Who writes the shared wiki | Caretaker layer separate from companion core; companions propose → dedup → operator approves; background cleanup (review §8) |
| 8 | World state authority | Rooms are channels; session holds presence; system-only entry messages; public vs time-gated private rooms; location system owns mechanics (review §7/§14) |
| 9 | Garden auth / topology | **One Garden per companion** + cluster fleet-health view (override of fleet-router); single operator token, operator sees all (review §6/§13) |
| 10 | Companion identity format | UUID companion IDs; intra-cluster trust automatic via shared signing certs; cross-cluster trust model deferred (review §2/§9) |
| 11 | Fleet-level charge ceiling | Not addressed — keep v1 lean: per-companion quotas first, observe, add gateway ceiling if needed |
| 12 | Voice/satellite routing | One companion per satellite/app; one-to-one routing like text; Wyoming approach non-final (review §12) |

Also confirmed: companion privacy leaks must surface loudly; full-review style approved.

## 6. Remaining open questions

- **Q-A (config mirror):** mirror per-companion config into the DB for live read/update with files as write-time source of truth (review §3 open point) — v1 lean: files only, add the mirror when a concrete live-read need appears.
- **Q-B (fleet view hosting):** where does the fleet-health view live given one-Garden-per-companion — gateway-served page (lean) vs. a small dedicated operator surface?
- **Q-C (time-gated private-room memory):** gating memory generation by join/exit times means L0 extraction must respect per-participant presence intervals — new requirement on the extraction pipeline; belongs to locations/session work per the §14 rule, but needs explicit design there.
- **Q-D (fleet charge ceiling):** per-companion lane quotas first; is a gateway-side aggregate ceiling needed once N companions heartbeat concurrently? Observe, then decide.

## 7. Deferred / follow-ups (tracked, not scoped into this sprint)

Per review §17:

- Cross-cluster direct companion communication trust model (shared key vs OAuth vs other; DM key exchange + secondary TCP-port validation; gateway as arbiter).
- Cognitive security firewall at the gateway (injected-command inspection; dangerous-actor channel cut).
- Cross-cluster / cross-world shared world-info sync (one world = one cluster for now).
- "Management" capability tier above autonomy (acting on other companions' settings; strictly higher gating).
- Detailed design of the shared-wiki caretaker/meta layer (dedup, rewrite, cleanup, LLM-assisted updates).
- Voice subsystem rewrite.
- Restore functions build-out.

## 8. Risks

- **Companion crossover = secret/privacy leak** — the top risk (review §5). Mitigation: companionId threaded through every correlation param, fail-closed routing, loud alarms, dedicated crossover tests under concurrent load.
- **Flag-off regression** — every W1/W2 change must be provably inert when the flag is off. Mitigation: parity tests per PR + `verify:settings-contract` extension for `companions.json`.
- **Epic collision with `psfn-framework-vinz`** — same seams (satellite registry, presence, situated context, wiki). Mitigation: locations-first sequencing (review §14); W5 is strictly deltas; `companion_presence` + wiki scope are the only new surfaces.
- **Cross-companion privacy leaks via shared surfaces** — shared schema, shared wiki, fleet view. Mitigation: nothing personal in the shared schema ever; caretaker + `filterPersonalFactProposals` on all shared-wiki writes; fold-review quarantine for peer assertions; leaks must surface, never be silently dropped.
- **Fatigue bypass** — any ICP path not entering the standard turn pipeline silently skips loop protection. Mitigation: hard rule — peer messages are channel turns, no side-channel dispatch; extend `two-companion-loop.test.ts` to the real channel path.
- **Operational blast radius** — one Postgres, one gateway = shared fate for N companions. Accepted; per-schema backups keep restore blast radius per-companion.

## 9. Immediate next actions

1. File the epic + issues in beads (from a checkout that reaches the beads server — `bd` has no database in this sandbox): locations-first ordering, W1–W7 as above, §7 follow-ups as future-idea beads.
2. Fold the Q-C requirement (presence-interval-gated memory extraction) into the locations epic's session/context workstream.
3. Spike (post-locations-threshold, or earlier if it doesn't touch location seams): two agent processes against one gateway with a hand-edited routing table — validates W1 and yields the first two-companion conversation demo.
