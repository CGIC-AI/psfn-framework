# Fleet Analysis Findings — 2026-07-14

Nine-agent investigation covering the operator's brain-dump list: contacts gaps, graph-proposal bug,
Garden privacy model, wiki delineation, emosim rollout, model hot-reload, Discord startup messages,
data deduplication, disk IO, and a live read-only profile of the private-cluster-host cluster. Analysis only —
no code changed, nothing deployed. Bead references verified against the local dolt tracker.

---

## 0. Headline findings (read these first)

1. **The biggest private-cluster-host perf win is already merged and just not deployed.** origin/main contains
   PR #42 (`84c0089e`, efficiency wave 1: Garden compression/caching, t5z7.1/.3/.6, 2z12.1) and
   PR #43 (`576e33cd`, hgw3 turn-record diet + Redis session tail). private-cluster-host runs image
   `0.1.0-kube-c0385f2b` — exactly one commit **before** both. Live measurement confirms the
   pre-diet behavior: ~561KB appended per turn record; turn records are **~614MB = 97% of the
   companion-data PVC**. Redeploying current main collapses the largest measured hotspot.
   (Local checkout is also 3 commits behind origin/main — `git pull` needed.)
2. **Graph proposals never form for a structural reason 0zd9 didn't scope.** The 0zd9 fix landed
   and works, but it only enables the `co_presence` evidence class, which is unreachable on the
   live topology. The two rich classes (`overheard_interaction`, `named_relationship`) require
   `provenance.subjectContactId`, which **no live code path ever populates** (LLM attribution
   tags are never emitted). Deterministic fix identified (S/M). See §2.
3. **Emosim on private-cluster-host has one gating engineering task.** private-cluster-host is ONE Helm release with a
   single shared settings.json; the sidecar's `sessionLabel`/`agentName` are static settings
   values, so enabling it naively blends all 5 companions into **one shared emo_sim session**.
   Per-companion session-label templating from `companionId` is required first (M). See §5.
4. **private-cluster-host hardware is nowhere near the bottleneck** — 3% CPU, 40% mem, <1.5% NVMe util at
   idle. Everything hot is code-side: turn-record write amplification, per-turn LLM fan-out,
   a broken ChatGPTN model wasting one LLM attempt per affected turn, a rollout crashloop race,
   and a 241MB orphaned session tree. See §8.
5. **Ops caution:** Helm revisions 28→35 churned with three rollbacks on private-cluster-host this afternoon
   (rev 35 deployed 18:42 BST) — another session appears to be iterating on the cluster. Check
   `helm history` before shipping anything. Pod env `PSFN_HELM_REVISION: 24` is stale/wrong.

---

## 1. Contacts system

### 1a. Gender / age / pronouns — do not exist anywhere
- Zero hits for gender/pronoun/age/birth-year fields across `src/` and `admin-ui/`. Contact model:
  `src/core/contacts/types.ts:266-283`; SQLite schema `src/core/contacts/store/schema.ts:64-78`;
  Postgres `src/persistence/postgres/migrations.ts:543-559`.
- **A reusable inferred-vs-specified provenance pattern already exists**: the
  `is_machine_intelligence` marker (`observed-machine-intelligence.ts:55-69`) distinguishes
  `system:channel_observation:*` actors (inferred, never clobbers operator edits) from operator
  actors, with per-field audit rows (`contact_mutation_audit`, audited-fields whitelist
  `types.ts:141-154`). New demographic fields should register there and get inferred-vs-specified
  for free.
- Extraction today produces only a freeform contact summary (`ContactProfileArtifact`,
  `memory-store-port.ts:27-34`) — no structured attribute slot. MVP path: operator-specified via
  Garden form (**S** once fields exist); inference pipeline is **L**.
- Full change: types + both schemas + hydration/upsert + Garden service payload whitelists
  (`contacts-service.ts:379-385, 635-639` silently drop unknown fields) + card UI. **Effort M.**

### 1b. Human vs companion — data exists, Garden UI is blind to it
- `Contact.isMachineIntelligence` is first-class, auto-detected (Discord `author.bot`
  `discord/adapter.ts:860`; inter-companion gateway lane stamps it true by construction
  `gateway/server.ts:651-663`), provenance-guarded, and shown on the **agent-facing** card
  (`tools.ts:546`). The **Garden admin card shows nothing** — the admin `Contact` type omits the
  field entirely and the service payload can't set it.
- Fix: add field to admin type + Human/Companion badge + payload/validation wiring to the
  existing `setMachineIntelligence` port. **Effort M** (mostly UI plumbing).
- Design wrinkle: `relationshipType: 'ai_companion'` duplicates the boolean; the boolean is
  load-bearing (fatigue policy). Recommend boolean-canonical, enum value derived/deprecated.

### 1c. Same-cluster companions default to acquaintance
- Auto-minted contacts get `stranger`/`public` (deliberate fail-closed floor,
  `upsert-resolve-operations.ts:280-288`). Garden-created contacts already default `acquaintance`.
- Sibling set IS defined (`fleetCompanionIds` from companions.json; gateway validates DM peers
  against it, `companion-channels.ts:33-38`) but **is never consulted at contact mint**.
- Sibling companions today: `isMachineIntelligence=true` but still `stranger`/`public`.
- Two seams: (a) plumb fleet membership into `resolveChannelIdentity` and default
  `relationshipType: 'acquaintance'` for companion-lane fleet peers at mint; (b) extend the
  observed-MI application step to nudge stranger→acquaintance with the same non-clobbering
  provenance guard. Recommend (a) for relationshipType only; leave the **trust** floor at
  `public` unless deliberately decided otherwise (fail-closed charter). **Effort M.**
- Note: bead 0ggv.4 (Purrsephone↔Artie) is the cross-cluster case, orthogonal to this
  intra-cluster fleet default.

## 2. Graph proposals still never form — root cause complete

0zd9's fix (`f8ae97fd`, live `e614380`) is correct and fully plumbed, but its scope only
unblocks one of three evidence classes. Three kill gates:

- **GATE A (dominant): `subjectContactId` is never populated on live.** Only
  `resolveStructuredFactRouting` sets it, and that requires LLM attribution tags the live
  extraction model never emits. Without it, `buildOverheardCandidates`
  (`graph-builder-worker.ts:261-263`) and `buildNamedRelationshipCandidates` (`:293-294`) bail
  on every memory. The "my sister Iki" edge class is permanently dead.
- **GATE B: `co_presence` (the class 0zd9 did enable) needs ≥2 distinct tracked contacts
  co-present in ≥3 windows.** Single-primary-user deployments can never satisfy it; untracked
  room members are skipped (`speaker-routing.ts:144-150`).
- **GATE C: pre-2026-07-09 memories have empty provenance and are filtered out.** Backfill bead
  **27ut is OPEN**, and the shipped backfill module (`memory-provenance-backfill.ts:172-190`)
  derives only `sourceContactId`/`addressMode` — never `subjectContactId` — so even running it
  doesn't revive the dead classes.

**Fixes:**
- **A (S/M, the real fix):** the mention-only path (`extraction.ts:669-682`) already resolves
  third parties into a contact and stamps `routedContactId` — the worker just doesn't use it.
  Fall back to `provenance.routedContactId` as the target in the two candidate builders (worker-
  only change), or (M, cleaner) populate `routing.subjectContactId` from mention-only resolution
  in the legacy lanes, fail-closed on ambiguity.
- **B (S):** document co_presence as inapplicable to single-user topologies; optionally lower
  `coPresenceMinSessions`.
- **C (M):** land 27ut and extend the backfill to derive `subjectContactId` the same way.
- Validation gate: builder logs `scanned>0 AND proposed>0` on a multi-user room after restart.

## 3. Garden privacy: subject-scoped memory hiding + audited cogsec override

~90% of the ask is already planned as epic **opl1** (chiefly opl1.11 subject-scoped memory JIT +
opl1.7 principal-aware authz + opl1.5 Discord principal↔contact binding, prerequisites
opl1.1/.3/.10). Current state:

- Visibility today is gated **only by sensitivity** (`memory-body-gate.ts:115-118` hides just
  intimate/confidential), never by contact/subject. "Admin" is a single shared token
  (`server-auth.ts:10-14`) — no principals, roles, or per-human audit actors
  (`AdminAuditActor = 'operator' | 'companion'`).
- Memory `contactId` is optional/nullable and often the conversation partner, not the subject;
  `subjectContactId` and episodic `participantContactIds` are separate. opl1.11 already warns
  against equating contactId with subject classification. A subject-classification layer with a
  fail-closed ambiguous branch is prerequisite work (**M**).
- Strong reuse candidate for the override flow: the cogsec quarantine confirm→decide two-step
  with full audit (`intake-quarantine-routes.ts`), plus opl1.10 passkey step-up binding.

**Two genuinely new deltas not in any bead (operator design decisions):**
1. **Subject-consent requirement** — no bead requires a *peer subject* to approve another
   admin's cogsec override. Options: subject-consent-required (the ask), owner-break-glass when
   subject unreachable, or dual-control. Needs an addendum bead under opl1.11/opl1.10.
2. **Hiding trigger scope** — the ask hides *any* contact-associated memory from non-subjects;
   opl1.11's default stays sensitivity-anchored (intimate/confidential). Decide whether
   personal/public contact-linked memories are also hidden.
   Also to decide: multi-subject rows (visible to A, B, both, neither — fail-closed default
   recommended) and companion-private reflections (owner-only recommended).

Leak paths beyond the body view (search snippets, counts, exports, bulk ops) must honor the same
gate — opl1.11 acceptance already enumerates them. Overall: blocked behind opl1.3/.5/.7 (**L**,
most of the epic); deltas above are **S** to spec now, **M–L** to build.

## 4. Wiki: world vs companion entries

**The premise is stale at the backend.** A full personal-vs-`shared_world:<siteId>` scope
dimension already shipped (commits `b75b855d`, `a0705063`): scope field + write guards
(`faculties/wiki/scope.ts`, `store.ts` — companion store fail-closed rejects shared-world
writes), Postgres `wiki_document_chunks.scope` + `shared_wiki_chunks` with CHECK constraint,
retrieval `allowedScopes` + shared-projection union, admin API
(`/api/admin/wiki/scopes`, `/api/admin/wiki/shared-world/:siteId` — mounted). Bulk import
(vinz.27) and places→wiki publication (vinz.4) are functionally implemented too.

**The only gap is the Garden frontend** — `admin-ui/src/routes/wiki/+page.svelte` is a flat
single-scope list; no client functions exist for the scope endpoints; nav has one Wiki entry.
The requested tabs are a **pure frontend task (S–M)**: scope-aware client fns + Personal/World
tabs (+ per-card scope badge, optional nav split).

**Bead hygiene:** vinz.28 / vinz.27 / vinz.4 are all still OPEN with stale premises — re-triage
against shipped code (close .27/.4, re-scope .28 to frontend-only). The caretaker
propose/approve/dedup layer (s10mc.5) remains future work (L), unrelated to the tab ask.

## 5. Emosim sidecar → private-cluster-host (all companions)

- **What it is:** shadow-mode observer sidecar (authoritative:false, hard-locked
  `observe_only`) projecting each turn's already-computed emotion snapshot into a separate
  Python emo_sim REST engine and recording a PSFN↔emosim crosswalk. **Zero extra LLM calls**;
  async fire-and-forget off the hot path (bounded queue, drop-newest, 5s timeout); 4 Postgres
  tables self-migrate lazily per companion schema.
- **Not running anywhere on private-cluster-host** (no emosim deployment/service exists there; the live
  single-companion experiment is on live-pi-host). Helm surface is complete
  (`templates/emosim.yaml`: 1-replica Recreate deployment, 1Gi PVC, NetworkPolicy restricting
  the unauthenticated engine to agent pods).
- **Gating issue (confirmed live): one Helm release, one shared settings.json** on the single
  system-data PVC. The `observerEvalSidecar` block's `sessionLabel`/`agentName` are static, so
  all 5 companions would push into ONE emo_sim session, blending their emotional states. The
  engine supports multiple sessions; **per-companion session-label templating from
  `companionId` is the gating code change (M)**.
- Also before rollout: verify bug **w05a.10** (sidecar fail-closes on terminal/most api turns —
  channel privacy metadata never populated; error-spam risk on a multi-channel fleet), set
  `deploymentTarget:'live'` (seed says `test_persona`), give the emosim pod explicit
  resources, keep NetworkPolicy on.
- Rollout: Helm enable + image build **S**; settings flip **S**; session-templating + w05a.10
  fix **M**; production-grade for all 5 **M–L**.

## 6. Model changes without reboot

- **Garden-driven models.json edits already hot-swap** in the running agent: save →
  `applySettings` mutates shared config in place → `refreshModels` hook re-resolves models +
  invalidates prompt-prefix cache (`settings-service.ts:136-158`,
  `substrate-agent.ts:598-620`). `LLMClient` builds model objects per call from live config —
  no client cache to rebuild.
- The reboot requirement comes from two gaps:
  1. **Direct disk edits are invisible** — no watcher on owner files; loads are one-shot at
     startup. Fix: mtime watch/poll → `loadModels` → existing refresh hook. **M.**
  2. **The gateway container is never signaled** (separate process; narrow impact — its
     injection model comes from env, not models.json). Cross-process signal **M–L** if wanted.
- Caveat: `LLMClient` constructor-caches LiteLLM base-URL/key from providers.json — provider
  endpoint changes still need a rebuild (**M**, separate concern).
- Precedent exists for surfacing "on-disk edited, live process stale" as a divergence state
  (charge-policy, settings-service.ts:830-849) — extend that pattern to anything unwatched.
- Related: the lifecycle/restart tool is not kube-correct (bead nt53) — making config reboot-free
  reduces how often that broken path is needed.

## 7. Discord startup messages: subsystem label

- The message is hardcoded `I'm back~ (startup took Ns)` (`lifecycle/notifications.ts:343`) and
  **only the agent process ever sends it** — the 2-3 duplicates per deploy (bead dq9c) are the
  same agent rebooting on gateway-replacement RPC loss, not different subsystems.
- Process identity is already available where the notifier is built
  (`agent/control-plane.ts:94-99` has the `RuntimeModeContract`). Fix: optional
  `subsystemLabel` in `LifecycleNotifierConfig`, include in ready/pre-restart/shutdown
  messages, update 2 test assertions. **Effort S.** Dovetails with dq9c's dedupe key.

## 8. Performance: duplication, disk IO, and live private-cluster-host profile

### 8a. Deployment gap (repeated from headline — the #1 action)
Deploy current origin/main (#42 + #43) to private-cluster-host. Live "before" baseline: ~561KB/turn-record
line, 218MB single Discord channel file, turn records ~614MB = 97% of companion-data PVC.
Autonomous lanes (quiet-hours/idle/dream-pass) write megabytes with nobody present.

### 8b. Remaining data duplication NOT covered by hgw3 (NEW work)
Per-turn turn-record duplication still present even after #43:
- **System-prompt material serialized ~4-5 ways per turn** (`plan.blocks`,
  `finalSystemSections`, `inputSections`, `plan.variables`, static/dynamic templates —
  ~190KB/turn, session-stable so cross-turn amplification is severe). Fix: content-address the
  static prefix by the already-computed `staticHash` into a sidecar. **M. Largest un-deduped
  chunk in scope.**
- **Retrieved memory content copied verbatim into every turn record**
  (`snapshot.memory.*Candidates` — embeddings stripped, text not). Fix: store memory ids +
  scores, resolve at Loom read time. **M.**
- **recentEntries (raw) + plan.messages (rendered) still 2x** — explicitly deferred by hgw3.3
  (redaction-interaction design needed). Fix: L0 entry-id ranges + divergence deltas. **M.**
- **Reflection journal stores full `internalState` alongside its own snapshot ref**
  (`reflection-journal.ts:95-118` vs `internal_state_snapshots`). Keep ref only — but confirm
  the journals-must-be-self-contained requirement first. **S-M.**
- **Refuted:** episodes do NOT copy turns — they're already reference-based (spanRefs +
  `l01_episode_message_claims` join by turn_id). Operator suspicion cleared; don't file.

### 8c. Disk IO / caching (NEW, all mode-agnostic, no Redis needed)
- **`_channel_index.json` fully rewritten on EVERY journal append** (2+ per turn, whole index of
  all channels, worsens with fleet size) — `journal-runtime.ts:393` → `channel-index.ts:139-160`.
  Debounce/coalesce or make append-only. **M. The clearest violation of "only L0 appends
  per-turn."**
- **Skills telemetry does full read+rewrite of the aggregate file per skill invocation**
  (`skills/telemetry.ts:204-265`). Keep in RAM, debounce flush. **S/M.**
- **`heartbeat-policy.json` bypasses the fingerprint cache** — raw readFileSync per Garden
  request and per heartbeat trigger (`heartbeat-policy.ts:504-506`). Route through
  `loadRequiredJsonCached` + invalidate on save; fix alongside the b9kb wrong-root bug. **S.**
- **Fatigue/charge ledgers never rotate**, whole-file re-read at boot — align with 2z12.4
  rotation theme. **M.**
- **Already solved / non-problems:** all mainstream owner configs are mtime-fingerprint-cached
  via `loadRequiredJsonCached` (goal "don't re-read unchanged configs" is largely done);
  internal-state/participant-trend/intention stores are DB-backed, not file rewrites.
- **Already filed:** t5z7.2/.3/.8/.9 (Garden), 2z12.2/.3/.4/.5/.6 (fleet), hgw3.5 (Redis tail).

### 8d. Live private-cluster-host findings (read-only observation, 2026-07-14 evening)
Topology: single-node k3s (16c/30Gi), ONE `psfn` Helm release rev 35, five agent Deployments,
shared system-data (2Gi) + companion-data (10Gi) PVCs. Node at 3% CPU / 40% mem / iowait ~0.
Postgres healthy (144MB on disk, gateway_audit capped ~50k rows).

Code issues found live, beyond the deployment gap:
1. **~241MB orphaned frozen turn-record tree** at `fleet/private-cluster-host/state/sessions/` (inode-
   distinct, frozen since the Jul-9 layout migration; live twin at top-level `state/`). One-time
   cleanup, ~40% of the PVC reclaimable together with rotation. Verify non-primary trees too.
2. **Rollout crashloop race:** every fleet rollout, all agents die on gateway RPC
   `ECONNREFUSED` — 10 retries/~9s budget is shorter than gateway readiness, and the fatal path
   exits 1 (bypassing the intended exit-75 reexec). Fix: longer/jittered retry budget or
   readiness gating. **S/M.**
3. **ChatGPTN returns provider template artifact `<｜begin▁of▁sentence｜>` → empty_response →
   deepseek fallback** on scheduled lanes — wastes an LLM attempt + round-trip per affected
   turn. Fix routing/template config for that model. **S.**
4. **Post-turn drain timeout** (5s) regularly exceeded under rapid turns
   (memory_extraction/emotion_appraisal/auto_compaction unfinished) — already the subject of
   mmo9.3 (BackgroundWorkSupervisor).
5. **Per-turn background LLM fan-out is the real cost center**: chat + emotion appraisal +
   1-4 extraction calls + concern-due appraisal + recent-summary + multi-range episode
   segmentation per user turn. Candidates: batch/coalesce appraisal+extraction prompts, skip
   unchanged-input reruns (2z12.6), admission control (mmo9.5).
6. Noise/small: `SkillsLoader` missing-path WARN every turn (`/app/companion/skills` unset);
   `[Settings] Loaded saved settings` re-fires repeatedly on the primary during Garden activity
   (worth confirming a save doesn't re-read the whole owner-file set); stale
   `PSFN_HELM_REVISION` env; no resource requests/limits on any psfn deployment (no OOM
   guardrail; also no pressure — 5×~1.1Gi agents on 30Gi).

---

## 9. Proposed beads (for filing after review — none filed yet)

| # | Title (short) | Type | Prio | Effort | Notes |
|---|---|---|---|---|---|
| B1 | Deploy main (#42+#43) to private-cluster-host + validate turn-record diet live | task | P1 | S | Coordinate with concurrent session (helm churn today) |
| B2 | Graph proposals: use routedContactId as subject fallback in candidate builders | bug | P1 | S/M | Reopens/extends 0zd9 scope; validation `scanned>0 && proposed>0` |
| B3 | Extend 27ut backfill to derive subjectContactId | task | P2 | M | Depends on B2 design |
| B4 | Contact cards: gender/pronouns/age fields with inferred-vs-specified provenance | feature | P2 | M | MI-marker pattern; operator-specified MVP first |
| B5 | Garden card: surface Human/Companion (isMachineIntelligence) badge + edit | feature | P2 | M | Data already exists |
| B6 | Same-cluster fleet companions mint as acquaintance (relationshipType only) | feature | P2 | M | Trust floor stays public unless decided otherwise |
| B7 | Wiki Garden UI: Personal/World scope tabs (frontend-only) | feature | P2 | S-M | Re-triage vinz.28/.27/.4 stale premises in same pass |
| B8 | Emosim per-companion session-label templating from companionId | feature | P1* | M | *Gates private-cluster-host rollout; pair with w05a.10 verification |
| B9 | Emosim private-cluster-host rollout (helm enable, settings flip, deploymentTarget live) | task | P2 | S-M | Blocked by B8 |
| B10 | Owner-file watcher → existing refreshModels hook (reboot-free disk edits) | feature | P2 | M | Extend divergence-state precedent; gateway signal separate |
| B11 | Lifecycle notifications carry subsystem label | feature | P3 | S | Pairs with dq9c dedupe |
| B12 | Channel-index rewrite per append → debounced/append-only | perf | P1 | M | Clearest "only L0 appends per turn" violation |
| B13 | Skills telemetry in-memory + debounced flush | perf | P2 | S/M | |
| B14 | heartbeat-policy.json through fingerprint cache (+ fix with b9kb) | perf | P2 | S | |
| B15 | Turn-record: content-address static system prompt by staticHash | perf | P1 | M | Largest remaining un-deduped chunk post-hgw3 |
| B16 | Turn-record: memory candidates by id-reference, resolve at Loom read | perf | P2 | M | |
| B17 | recentEntries as L0 id-ranges (hgw3.3 deferred item, needs redaction design) | perf | P2 | M | |
| B18 | Reflection journal: drop embedded internalState copy (keep ref) | perf | P3 | S-M | Confirm self-containment requirement first |
| B19 | private-cluster-host: delete 241MB orphaned fleet/private-cluster-host session tree | task | P2 | S | One-time, verify inodes/mtime before removal |
| B20 | Agent startup: gateway-connect retry budget / readiness gating on rollout | bug | P2 | S/M | Exit-1 vs exit-75 path too |
| B21 | ChatGPTN template-artifact empty responses → fix routing/template | bug | P2 | S | Wasted attempt per affected turn |
| B22 | Fatigue/charge ledger rotation | perf | P3 | M | Fold into 2z12.4 theme |
| B23 | opl1 addendum: subject-consent cogsec override + hiding-trigger scope decision | design | P2 | S spec | Two operator decisions in §3 must be made first |

## 10. Operator decisions (RESOLVED 2026-07-14, same day)

Operator reviewed the findings and decided:

1. **private-cluster-host deploy (B1): approved.** The helm rollback churn was the operator running two
   deploy agents concurrently — the rule going forward is one deploy at a time; no code fix
   needed for that. The frozen `fleet/private-cluster-host` record tree likely dates to the cogsec incident;
   cleanup (B19) still valid.
2. **Graph proposals (B2/B3): proceed.** Operator notes the humans in the rooms don't talk
   much, so even after the fix, data may be thin — set expectations in validation.
3. **NEW SCOPE — settings split:** per-companion settings vs cluster-global settings must become
   an explicit ownership split. This is the strategic fix for the emosim session collision and
   future per-companion config. Additionally: **audit for other unintentional shared seams** in
   the single-release fleet topology (wiki, images in chat, scratchpads, scheduler cadences,
   charge budgets, etc.) — anything cluster-global that is semantically per-companion.
4. **Loops (§8d.5):** the per-turn fan-out is accepted as necessary; the work is clearing race
   conditions — apply the memory-subsystem pattern (if a concurrent task doesn't come back in
   time, proceed with last turn's result) across post-turn loops. Relates to mmo9.3/mmo9.5.
5. **Channel index (B12): confirmed** — write only on change; channels change rarely.
6. **NEW — bounded session hot-cache:** high agent RSS is probably cache and cache-over-disk-IO
   is the right trade, but bound it deliberately: e.g. keep only functional state hot (last ~1k
   sessions per companion) with search/hydrate-on-demand for older; thousands of sessions ×
   half a dozen companions must not all live in memory. Memories are lower-risk (grow slower
   than chat turns).
7. **Privacy (replaces B23 options):**
   - Hide **all NAMED (contact-associated) memories** from any logged-in admin who is not the
     subject — regardless of sensitivity level, because procedural/reflection content can
     allude to intimate-level material. **Piggyback on the existing intimate/high-intimacy gate
     mechanism — do not build a parallel system.** Memories are already attributed to who
     they relate to.
   - The **derived user profile/bio** (contact profile artifact) is likewise hidden unless that
     admin/user is logged in as the subject. Both land after Discord SSO (opl1, in flight).
   - **Cogsec override = audited break-glass only.** No subject-consent request/approval
     system — too much work. Full audit trail; for emergencies to fix things, not casual
     access.
   - **Reflections** (which pull from all memory) are acknowledged hard; memory + profile gates
     are the minimum for now; a multi-admin escalation gate is a future design question. This
     whole pattern evolved from multi-companion implementation rather than being designed —
     revisit deliberately later.
8. **Emosim (B8/B9): approved** — fleet sidecar on private-cluster-host for tracking data in the group
   environment until the main Purrsephone test (live-pi-host) concludes. Per-companion session
   identity is the prerequisite (tactically B8; strategically the settings split in #3).
9. **Wiki (§4):** operator amused the backend already shipped ("another case of me forgetting
   I did shit") — same pattern as hgw3 (merged but undeployed). Re-triage stale beads.

## 11. Shared-seams audit (follow-up to §10.3, completed same day)

Structural root cause: `load-config.ts` roots ALL 12 owner files at the shared `systemDataDir`
(`startup-owner-files.ts:210-281`); `companionDataDir` only drives databasePath, characterCard,
and pg schema. **No per-companion settings override mechanism exists anywhere.** WORKSPACE_PATH
is likewise one value inherited by every agent (doc-acknowledged limitation).

### Ranked unintentional seams (beyond the confirmed emosim one)

1. **`observerEvalSidecar.sessionLabel/agentName/deploymentTarget`** — confirmed (latent until
   enabled). One emo_sim session for all companions.
2. **`capability-tier.json`** — all companions forced to ONE maturation tier; a nursery and a
   mature companion cannot coexist. Always-on, high blast radius (gates tools/capabilities).
3. **`activeTimezone` (settings.json)** — one clock for the whole fleet; overrides env TZ;
   drives scheduler wall-clock, rest windows, formatters. Always-on.
4. **`scheduler.json` circadian** — heartbeat/tick cadence, episodic rest window,
   `morningWake.localTime`, freeTime, sleepConsolidation: all five wake/sleep/loaf on one
   schedule. Destroys rhythm individuation. Always-on.
5. **Shared personal workspace** (WORKSPACE_PATH): personal wiki (`store.ts:528` — confirmed
   shared, NOT per-companion), personal/managed skills, scratchpad, modules, journal,
   downloads, **inbound chat attachments/images** (discord `adapter.ts:787-790`, telegram
   `adapter.ts:1535-1547`, `images/service.ts:383-389`), beads. Cross-companion data leakage +
   write races. (Generated/outbound images and identity assets are correctly per-companion.)
6. **`voice*` settings** — all companions target one guild/user/voice channel.
7. **Mis-wired `config.dataDir` (should be companionDataDir)** — `garden-audit-history.jsonl`
   (`local-admin-contract.ts:197`), Garden `heartbeat-policy.json`
   (`scheduler-service.ts:290` — layout signature at `layout.ts:740` intends companionDataDir;
   compounds bead b9kb), reflection-metacognition journal. Independent S-effort bugs.
8. **Model-usage ledger JSONL** (`model-budget.ts:338`) — spend accounting mixes companions
   (Postgres per-schema store mitigates).
9. **`emotionScoping`** — shared per-companion emotional-scoping params.
10. **Needs-decision tier:** trust-policy, intake-policy, charge-policy budgets, skills.json
    enabled set, wikiRetrieval*, cognition-tuning knobs (memoryExtraction*, profileSynthesis*,
    etc.), discordTrigger*.

Intentionally global (verified, leave alone): models.json, providers.json, channels.json
(per-account `companionId` routing), backup.json, companions.json, satellite-registry,
places.json, shared-world wiki, gateway-audit.db, embedding*/textEmotion* (must match shared
vector infra).

Per-companion state done right (the pattern to copy): everything routed through
`resolveConfiguredCompanionDataDir` in `local-admin-contract.ts:178` — charge/fatigue ledgers,
cogsec events, quarantine, prompt layers, core memory, etc.

### Recommended split design
- **(c) Move unambiguous owner files per-companion** — capability-tier.json and scheduler.json
  circadian → companionDataDir (M per file): startup-owner-files load path + contract-guard
  scope + backup slices + per-companion Garden editors move in lockstep.
- **(a) Per-companion `settings.overlay.json` in companionDataDir** deep-merged over global
  settings.json for a scoped whitelist (activeTimezone, voice*, observerEvalSidecar,
  emotionScoping, uiThemeId, discordTrigger*), re-validated through the existing normalizer;
  absent overlay = byte-identical behavior (S/M).
- **Fix the dataDir mis-wirings** as independent S bugs now (seam 7).
- **Workspace isolation** is its own L track (already noted as deferred in
  docs/multi-companion.md).

## 12. Original open questions (superseded by §10)
1. **Privacy §3:** (a) subject-consent vs owner-break-glass vs dual-control for the cogsec
   override; (b) hide ALL contact-associated memories from non-subjects or only
   intimate/confidential; (c) multi-subject visibility rule; (d) companion-private reflections
   owner-only?
2. **Contacts §1c:** should sibling-companion default bump only relationshipType (recommended)
   or also the trust floor?
3. **Emosim §5:** proceed with fleet rollout as a shadow experiment expansion (it is not yet a
   promoted product feature — w05a.9 decision is deliberately frozen until 2026-07-20)?
4. **private-cluster-host deploy:** who owns shipping main→private-cluster-host given today's concurrent helm churn?
