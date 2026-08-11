# Architecture Sprawl Audit — Validated

**Date:** 2026-08-06
**Scope:** Validate (against current code) the sprawl claims carried in beads
m96g, 5jx2v, z3e2x, alco2, 6q4j, 99ugi, 9g0c, z6z, yje3l, owffl, z7qe, plus a
fresh pass for god-modules and parallel abstractions. Goal stated by operator:
*minimize complexity, reuse existing parts, merge where possible, consistent
surfaces for similar things (schedule/automata).*

## Method and provenance legend

Every claim below was re-derived from the working tree by reading the file and
running the grep. A prior agent's synthesis was treated as **testimony** and is
cited only where I independently reproduced it; where its file:line drifted, the
corrected reference is given.

- **[computed]** — I read the file / ran the command in this audit.
- **[testimony]** — reported by another agent; **not** reproduced here. Welcome
  as a lead, but does not justify a change until someone verifies it.
- **[verified-testimony]** — another agent claimed it and I reproduced it.

Where the prior agent's references were stale or wrong, I flag it explicitly —
that is the point of this document.

## Headline

The sprawl is real and clusters into five shapes. In every case **the merge
target already exists in the repo**; the work is folding duplicates into it, not
building new infrastructure. The single highest-leverage fact discovered: the
one cross-cutting automata enumeration m96g cited
(`working_docs/prompt-audit-findings-20260714.md`) **no longer exists** — there
is now literally zero enumeration of background work, which makes m96g more
urgent, not less.

---

## Cluster A — Automata have no registry, and the only list rotted away

**[computed]** `Scheduler.register(task)` (`src/core/scheduler/scheduler.ts:286`)
is the existing unified surface for clock-driven work. `background-work` already
uses it correctly (`src/core/agent/background-work/scheduler-task.ts:18`). The
surface exists; ~13 production `setInterval` sites bypass it.

**[computed]** Garden renders only scheduler-registered tasks:
`src/operator/garden/routes/scheduler-routes.ts:30-57` returns
`scheduler.listTasks()` and nothing else. No route enumerates the other spawners.

**[computed]** The "rotting doc table" m96g pointed at is gone:
`working_docs/prompt-audit-findings-20260714.md` does not exist (checked
2026-08-06). The m96g description still references it. So the doc-table claim is
now stronger: there is no enumeration at all.

### Validated spawn inventory (Bucket A — autonomous recurring, should register)

| Mechanism | Site | In m96g? |
|---|---|---|
| Background-work lease heartbeat | `src/core/agent/background-work/supervisor.ts:878` | yes |
| Memory decay sweep | `src/faculties/memory/decay.ts:97` | yes |
| Cross-process lock heartbeat | `src/persistence/sessions/cross-process-lock-heartbeat.ts:49` | yes |
| Contact-lifecycle recovery | `src/core/contacts/contact-lifecycle-recovery-runtime.ts` | yes |
| Skills telemetry flush | `src/faculties/skills/telemetry.ts` | yes |
| Cert-manager sweep | `src/app/cert-manager/main.ts:92` | yes |
| Observer-sidecar drain | `src/core/eval/observer-sidecar/queue.ts` | yes |
| Inline-image retention | `src/boundary/gateway/inline-image-retention.ts` | yes |
| Owner-file reload watcher | `src/operator/garden/services/owner-file-reload-watcher.ts:61` | **no — new** |
| Long-running-tool-status GC | `src/channels/shared/long-running-tool-status.ts:35` | **no — new** |
| Analysis-workbench memory guard | `src/boundary/sandbox/execution/analysis-workbench-child-source.ts:509` | **no — new** |

m96g's count of 11 is short by at least 3 found in this pass. The bead should be
re-inventoried before decomposition.

### Bucket B — transport keepalive (different home, not Scheduler)

**[computed]** Discord adapter holds 4 `setInterval`s; telegram adapter, gateway
client/server, companion-ui-websocket, companion-relay-routes each hold one.
These are channel-transport liveness, not companion cognition. Folding them into
`Scheduler.register` is a category error; their home is a transport-health
surface, not the cognition clock. Call this out so the m96g lint rule does not
force them through the wrong door — they need an allowlist entry, not
registration.

### Merge recommendation (m96g)

Cheapest correct shape, no new subsystem:
1. Extend `ScheduledTask` (`src/core/scheduler/types.ts`) with `chargeSurface`,
   `concurrencyClass`, `maxLlmCalls`.
2. One lint rule failing on `setInterval` / self-rescheduling `setTimeout`
   outside an allowlist (transport keepalives + request timeouts exempted).
3. Garden reads the scheduler task list it already has; add the three fields to
   the existing `/api/admin/scheduler` response, do not build a parallel route.

---

## Cluster B — Startup liveness: two P1s, and three parallel full-file readers

### B1 — 5jx2v: SessionStore startup priming still synchronous **[verified-testimony]**

**[computed]** `src/persistence/sessions/store.ts:423` calls
`this.primeChannelIndexFromDisk()` from the constructor (a `void` method).
**[computed]** `store.ts:609-617` loops every indexed session, calls
`scanArchiveMetadata` across every L0 JSONL byte, and on tombstone/quarantine
evidence calls `readTurnTombstoneAuthorityFromChain` synchronously. Bead 5jx2v's
description matches current code.

**[computed]** The correct off-loop implementation already exists:
`readTurnTombstoneAuthoritySnapshot` (`src/persistence/sessions/turn-tombstone-authority.ts`)
forks a child process, yields cooperatively, and bounds row size — but it is
called only at `store.ts:1749` (request-time cursor work). Startup still uses the
old synchronous `journalRuntime.readTurnTombstoneAuthorityFromChain`.

**Implication:** the fix for 5jx2v is *delete the sync path and route startup
through the existing worker*, not "build async priming." Two implementations of
the same operation is the sprawl; removing one is the merge.

### B2 — z3e2x: `readJsonLines` is genuinely unbounded **[verified-testimony]**

**[computed]** `src/persistence/jsonl.ts:57` `readJsonLines`:
`readFileSync(path, 'utf-8')` → `raw.split('\n')` → `JSON.parse` every line into
a full array → returns **all** entries; caller limits applied afterwards. O(file
size) memory and parse, synchronous on the primary loop.

**[computed]** Reachable with full history at:
- `src/core/intention/outreach-outbox.ts:167` — startup hydration.
- `src/persistence/journals/reflection-journal.ts:298,310,356,374` — four call
  sites.
- `src/persistence/journals/reflection-substrate.ts:253`.
- `src/faculties/skills/store.ts:535`.

### B3 — NEW in this audit: a third parallel full-reader **[computed]**

`src/shared/telemetry/charge-ledger.ts:273` does its own
`readFileSync(path, 'utf-8')` + parse — not via `readJsonLines`, not via
`jsonl-segments.ts`. So there are **three** independent "read a whole JSONL file
into memory" implementations:

1. `src/persistence/jsonl.ts:57` `readJsonLines` — full file, sync.
2. `src/shared/telemetry/charge-ledger.ts:273` — full file, sync, bespoke.
3. `src/persistence/jsonl-segments.ts` — bounded, chunked, has an async variant.
   This is the correct primitive.

**Merge recommendation:** `readJsonLines` and the charge-ledger reader should
both route through the bounded `jsonl-segments` primitives (or gain the same
`maxLineBytes` + cooperative-yield discipline). Collapsing three readers to one
bounded one closes z3e2x and the charge-ledger growth path together.

---

## Cluster C — Memory: model is sound, lifecycle is zombie-prone

### C1 — alco2: consent producer gap **[mostly verified]**

**[computed]** The `consent_flags` column is plumbed end to end: written at
`src/faculties/memory/postgres-store/rows.ts:277` (`memory.consentFlags ?? {}`),
read back with `normalizeConsentFlags`, merged in `writer.ts`, gated by
`allowRecall === 'false'` in retrieval and admin queries.

**[computed]** The main memory producer never sets it: `src/faculties/memory/extraction.ts`
contains **zero** `consentFlags` references. The only place in the tree that sets
`allowRecall: false` is a test fixture
(`src/core/session/group-chat-harness/fixtures.ts:757`). So the field is
writeable, readable, mergeable, and enforced — but no production path populates
it. alco2's "gate is enforceable but unsettable" framing is reproduced.

**[testimony]** The specific claim "100% of live rows are `{}` (2728 Companion
+ fleet counts)" requires a live DB query I did not run. The code evidence is
consistent with it but does not prove the row counts.

### C2 — 9g0c: concern TTL buckets vs exponential decay **[verified-testimony]**

**[computed]** `src/core/intention/concerns.ts:181` defines fixed buckets:
`high: 48h, medium: 24h, low: 8h`, capped by `MAX_ACTIVE_CONCERN_LIFETIME_MS = 7d`
(line 179).

**[computed]** The charter-correct exponential decay already exists:
`src/faculties/memory/decay.ts:30` `calculateEffectiveMemorySalience` uses
`Math.exp((-Math.LN2 * dt) / halflife)` with a per-type `salienceFloor` and
per-type `halfLifeDays` from policy. Two adjacent subsystems, two decay models.

9g0c's scope — replace concern bucket expiry with the same per-category decay,
reinforcement on re-mention, resolved-contradicted fade — reuses `decay.ts`'s
shape. The pattern to copy is in the repo.

### C3 — 6q4j: concern grooming marks resolved, never purges or reweights **[verified-testimony]**

**[computed]** `src/core/intention/concern-grooming.ts:97` `groomConcernSet`
does exactly two things: `resolveStaleConcerns` (expiresAt <= asOf) and cap
overflow via `selectConcernsToKeep`. It marks resolved; it does **not** hard-purge
and does **not** decay/reweight salience.

**[computed]** `src/core/scheduler/rest-window.ts` has zero `concern` references
(grep count 0). Concerns are not rest-window aware.

**[testimony]** The "ghost concerns with malformed/March-dated expiresAt escape
forever" claim is plausible given grooming keys only on `expiresAt <= asOf`, but
I did not trace the malformed/null-`expiresAt` write path to confirm the escape.
The grooming-logic half is verified; the escape mechanism is a lead.

### C4 — 99ugi: dampening is contact-scoped **[testimony]**

Not independently traced in this pass. Bead exists; the claim that one
contradicted resolution damps all of a contact's thoughts (and that grooming
resolutions also damp) needs a read of the dampening code before acting. Flagged
for verification.

### C5 — yje3l: pgvector ANN index **[partially verified]**

**[computed]** `src/faculties/memory/postgres-store/embedding-index.ts:8-48`
confirms real structural complexity: the embedding column is an unbounded
pgvector `VECTOR` (runtime dimension is config-owned), and ANN queries cast on
the fly via `embedding::vector(N)`. HNSW index names are dimension-pinned
(`idx_l2_memories_embedding_hnsw_cosine_d<N>`). Raising `embeddingDims` silently
breaks expression matching. This is genuine flake/race surface area.

**[testimony]** The "20% flake even isolated" rate is not reproducible from
static code; it needs CI run history. The async-index-build-race framing is
consistent with the dimension-pinning complexity but unverified here.

### C6 — z6z / m58.* / 1xb.4: recall expansion not implemented **[testimony]**

Not traced in this pass. Bead z6z exists; spec `SPEC_MEMORY_PROJECTION_LAYER.md`
referenced. Flagged: verify the spec exists and retrieval.ts lacks
`recall_expand` before scoping.

### Dependency order (reproduced from prior agent, stands to reason)

6q4j purge → 9g0c decay + 99ugi dampening → z6z recall expansion. Decay must not
operate on ghost data.

---

## Cluster D — CogSec: prior agent's file:line refs are stale; gap is narrower but real

The prior synthesis named three wired call sites
(`context-builder.ts:437, substrate-agent.ts:909, core-runtime.ts:297`). Those
specific sites do **not** carry `evaluate()` calls in the current tree. The real
map, **[computed]**:

| Sink | Wired `evaluate()` site | Status |
|---|---|---|
| `prompt_assembly` | `src/core/session/intake-sink-gating.ts:220` | wired |
| `memory_write` | `src/faculties/memory/writer.ts:369`, `src/faculties/memory/extraction/fact-acceptance.ts:171` | wired |
| `skill_write` | `src/faculties/skills/tools.ts:280,306` | wired |
| `tool_egress` | `src/core/agent/substrate-agent/egress-tool-guard.ts:44` | wired |
| `wiki_write` | — | **no evaluate() site found** |
| `persona_mutation` | — | **no evaluate() site found** |
| `trust_mutation` | — | **no evaluate() site found** |

**[computed]** `INTAKE_SINKS` (`src/shared/contracts/intake-envelope.ts:158`)
has 7 values. Gate *logic* and *policy config* are tested for all 7
(`src/core/cogsec/intake/sink-gates.test.ts:75,87,523`;
`src/system/config/intake-policy-config.test.ts:528-529`). But no test asserts
that every sink has a wired `evaluate()` enforcement point. So owffl.2's spirit
is right — the fitness gap is real — but the corrected statement is "3 of 7 sinks
have gate logic with no proven wired enforcement," not "only 3 call sites total."

### owffl.5 — HMAC chain is structurally opt-in **[computed]**

**[computed]** `src/persistence/sessions/store-primitives.ts:130`
`createKeyringIntegrityProvider(keyring)` returns `null` when `keyring` is null.
**[computed]** `store.ts:398` does
`?? createKeyringIntegrityProvider(options.integrityKeyring ?? null)`, so a null
keyring yields a null provider and no verification. The opt-in is real and
load-bearing.

**[testimony]** "Nothing asserts production composition constructs with a
keyring." I confirmed composition passes `integrityProvider` through
(`src/app/startup/composition/composition.ts:217`), but I did **not** trace the
full agent/gateway `main.ts` → composition wiring to prove a non-null keyring is
constructed in production. That trace is needed before claiming the chain is
unenforced in prod. Flagged: verify the keyring construction site in main.ts.

---

## Cluster E — God-modules and bespoke reservations (fresh pass)

### E1 — God-modules **[computed]**

Largest non-test files:

- `src/boundary/gateway/server.ts` — **3857 lines**, single `GatewayServer` class.
- `src/persistence/sessions/store.ts` — **2916 lines, 89 methods** in one class
  (cache + tombstone authority + journal writer + crash recovery + priming).
- `src/boundary/gateway/client.ts` — 2887.
- `src/persistence/postgres/model-usage-store.ts` 2609;
  `src/system/config/scheduler-config.ts` 2302;
  `src/primitives/llm/client.ts` 2172;
  `src/faculties/memory/postgres-store.ts` 2167;
  `src/core/session/manager.ts` 2120.

`store.ts` is the worst by method count and is the natural home for the 5jx2v
fix; splitting it (cache / tombstone / journal / recovery / priming) unblocks B1.
Only **4** `TODO`/`FIXME` across all of `src/` — debt is under-annotated, not
absent. `src/faculties/shards/fold-review.ts:15` carries the TODO AGENTS.md flags
("fold review gates the shard's OUTPUT, but nothing…") — confirmed present.

### E2 — Concurrency-control sprawl: file locks good, reservations bespoke **[computed]**

**Already consistent — do not churn:** every *file* write lock funnels through
one primitive, `withCrossProcessWriteLock`
(`src/persistence/sessions/cross-process-write-lock.ts`).
`channel-index-write-lock.ts` (16 lines) and `session-journal-write-lock.ts`
(22 lines) are thin wrappers. This is the model.

**Sprawl:** "claim exclusive right to act" is re-implemented per domain with no
shared abstraction:

- `src/persistence/postgres/turn-record-eligibility-fence.ts` (194, DB-backed).
- `src/core/agent/substrate-agent/turn-run-reservation.ts` (188).
- `src/core/agent/fatigue/regulation-reservation.ts` (86).
- `src/core/agent/arbiter/reservation-phase.ts` + `egress-lease-phase.ts`
  (speaking arbiter).
- `src/persistence/sessions/cross-process-lock-heartbeat.ts` (lease renewal).

All are "reservation/lease with heartbeat + expiry." A shared `Reservation`
primitive, modeled on `withCrossProcessWriteLock`, would collapse four to five
bespoke implementations. Lower priority than A–D, but the same disease.

---

## Cross-cutting merge map (every target already exists)

| Sprawl | Merge into (existing) |
|---|---|
| 11+ background `setInterval` automata | `Scheduler.register` + 3 new `ScheduledTask` fields |
| Sync tombstone priming (5jx2v) | existing `readTurnTombstoneAuthoritySnapshot` worker |
| 3 parallel full-JSONL readers (z3e2x + charge-ledger) | bounded `jsonl-segments` async primitives |
| Concern bucket TTL (9g0c) | `calculateEffectiveMemorySalience` decay shape |
| Bespoke domain reservations | `withCrossProcessWriteLock` pattern |
| Garden automata blind spot | existing `/api/admin/scheduler` response + fields |

Nothing in the right column is new. The work is deletion-and-folding, not
greenfield.

## Suggested order (leverage / risk)

1. **B1 (5jx2v)** — route startup through the existing worker, delete the sync
   path. Fixes a P1 and removes a parallel impl in one move.
2. **B3 (3 readers → 1)** — collapse `readJsonLines` + charge-ledger into bounded
   `jsonl-segments`. Closes z3e2x and the charge-ledger growth path together.
3. **A (m96g)** — re-inventory (it is short by 3), extend `ScheduledTask`, add
   the allowlist lint. The rotting-doc reference must be removed from the bead.
4. **E1 store.ts split** — unblocks B1 cleanly and is the worst god-module.
5. **C2/C3 (9g0c + 6q4j)** — reuse `decay.ts`; purge before decay per dependency.
6. **D (owffl.2/.5)** — add the per-sink fitness test (corrected sink list) and
   trace the prod keyring wiring.
7. **E2 (Reservation primitive)** — lowest leverage, do last.

## Provenance caveats — what this audit did NOT verify

These items require **live-system access** (DB queries, CI run history, or a
full prod wiring trace). They are routed to whoever the operator grants that
access to; they are explicitly out of scope for this read-only pass and must not
be acted on from the `[testimony]` framing alone.

- **alco2 row counts** ("100% of live rows are `{}`", fleet counts) — needs a
  live DB query. Code is consistent with the claim.
- **6q4j escape mechanism** (malformed/March-dated `expiresAt` bypassing groom) —
  grooming logic verified; the specific escape path not traced.
- **99ugi dampening scope** — not traced in this pass.
- **yje3l 20% flake rate** — not reproducible from static code; needs CI history.
  Structural complexity (dimension-pinned HNSW) verified.
- **owffl.5 production keyring wiring** — opt-in structure verified; the
  main.ts → composition → keyring construction site not traced to confirm prod
  passes non-null.
- **z6z/m58/1xb.4** — bead exists; implementation gap not traced here.

Each of these is a one-command-or-one-query check before any of them may enter a
commit or a fix. Being confident is not the same as having checked.
