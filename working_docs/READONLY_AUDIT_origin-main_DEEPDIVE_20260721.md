# PSFN Deep-Dive Audit (follow-up)

**Base:** `origin/main` @ `f8f798d13`  
**Date:** 2026-07-21  
**Relation:** Supersedes the severity framing of the first pass on Garden auth + CogSec shadow. That pass was a perimeter skim; this one digs into memory, subject isolation, fleet posture, and store mechanics.  
**Further:** [`READONLY_AUDIT_origin-main_SEAMS_20260721.md`](./READONLY_AUDIT_origin-main_SEAMS_20260721.md) covers L0 provenance, extraction multi-human routing, privacy matrix layers, turn pipeline, and automata efficiency.

---

## Corrections to first pass

| First-pass claim | Operator correction | Revised verdict |
|---|---|---|
| Garden unauth token gap is HIGH | Garden not reachable in kube; direction is fleet + SSO | **Withdraw as production risk.** Legacy single-companion token path still exists in code for non-fleet; fleet-SSO path is the real surface (and is much tighter). |
| CogSec shadow seed is MEDIUM charter gap | Shadow intentional; freshly built; needs soak/test | **Withdraw as defect.** Keep as *rollout state*, not bug. Structural enforce path exists and is wired. |
| God files | “eh” | Park as known debt; not primary findings. |
| Surface skim | Fair | This document is the actual deep cut. |

---

## 1. Memory store architecture (the load-bearing surface)

### 1.1 Full-corpus process hydration

**File:** `src/faculties/memory/postgres-store.ts:254–276`

On `initialize()`, the store:

```sql
SELECT ... embedding::text AS embedding FROM l2_memories ORDER BY ...
```

…loads **every** L2 row into:

- `this.memories: Map<string, PurrMemory>`
- `this.embeddings: Map<string, Float32Array>`

plus delete versions, links, scratchpad, contact profiles, etc.

**Implications:**

| Axis | Effect |
|---|---|
| Startup | Latency and RSS scale with lifetime memory count × embedding dims |
| Multi-companion fleet | Each agent process hydrates **its schema** fully — good isolation, still O(corpus) per companion |
| Correctness of `getById` | Cache-only: `return this.memories.get(id)` (`:1004–1006`). Fine **if** all writers update the same process map; wrong model if any external writer mutates Postgres without going through this process |
| Correctness of `searchByText` (raw) | In-memory lexical over the Map only (`:769–792`) |
| Correctness of `countActiveMemories` (raw) | Scans the Map (`:1000–1002`) |

Authorized subject queries **do** hit Postgres (`queryAuthorizedMemorySubjects` → `subject-queries.ts`). Product retrieval uses that path when `enforceSubjectAuthorization=true` (composition wires `true` at `composition.ts:494–515`).

**Finding M1 — HIGH for scale, not a secrecy bug:** The dual model (full RAM mirror + SQL authorized path) is the dominant long-term cost center. Companion with 50k–200k memories × 1536-d float embeddings is multi‑GB RSS before the agent does anything.

---

### 1.2 No ANN index on `l2_memories.embedding`

**Migrations:** `src/persistence/postgres/migrations.ts`

Present:

- `idx_l2_memories_embedding_present` — partial B-tree on `id WHERE embedding IS NOT NULL` (not an ANN index)
- GIN on `search_vector` (lexical — good)

**Absent:**

- `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` (or ivfflat)

**Product vector path** (`subject-queries.ts: embedding_search` case + MATERIALIZED authorized CTE):

```sql
WITH authorized AS MATERIALIZED (
  SELECT ..., 1 - (memory.embedding <=> $n::vector) AS similarity
  FROM l2_memories memory
  WHERE <active> AND <subject EXISTS predicate>
  ORDER BY memory.embedding <=> $n ...
)
SELECT ... LIMIT/OFFSET
```

Even **with** an HNSW index later, a `MATERIALIZED` CTE over a heavy `EXISTS` subject filter often forces “filter then sort by distance” (or vice versa) rather than pure ANN top-k. Today there is **no** ANN index at all → sequential distance evaluation over authorized rows (or the whole table on the raw path).

**Finding M2 — HIGH performance:** pgvector is used as a column type and distance operator without an approximate nearest-neighbor index. Latency grows roughly with authorized corpus size per turn.

---

### 1.3 Raw `searchByEmbedding` has no SQL `LIMIT`

**File:** `postgres-store.ts:726–767`

```sql
SELECT ... 1 - (embedding <=> $1::vector) AS similarity
FROM l2_memories
WHERE embedding IS NOT NULL AND superseded_by IS NULL AND deleted_at IS NULL
  AND 1 - (embedding <=> $1::vector) >= $2
ORDER BY embedding <=> $1::vector ...
-- no LIMIT
```

Then JS `.filter(scope).slice(0, limit)`.

**Production product retrieval** does **not** call this when subject auth is on — it goes through the proxy:

```ts
// subject-authorized-store.ts:276–294
searchByEmbedding → queryAuthorizedMemorySubjects({ kind: 'embedding_search', limit })
```

which clamps limit to ≤500 (`subject-queries.ts`).

**Finding M3 — MEDIUM (trap / secondary paths):** Raw store embedding search is unbounded. Any caller that uses the raw `MemoryStorePort` (tests, maintenance, future wiring that forgets `enforceSubjectAuthorization`, sleeptime paths that grab raw store) can pull the full threshold-matching set.

Default constructor of `MemoryRetriever` is `enforceSubjectAuthorization = false` (`retrieval.ts:265`). Production composition passes `true`. That asymmetry is a footgun for alternate entrypoints.

---

### 1.4 N+1 authorized `getById` (confirmed and worse than first pass)

**File:** `retrieval/access-context.ts:102–104`

```ts
await Promise.all(sourceMemoryIds.map(id => input.memoryStore.getById(id)))
```

When `memoryStore` is the **subject-authorized** proxy (`subject-authorized-store.ts:321–329`), each `getById` becomes:

```ts
queryAuthorizedMemorySubjects({
  authorization: auth,  // full subject predicate
  selector: { kind: 'detail', memoryId },
})
```

That is **one SQL query per source id**, each with the large `EXISTS (… classifications JOIN contacts …)` predicate from `subject-policy.ts:44–123`.

Same pattern:

- `retrieval/social-context.ts:185` — `getById(link.targetMemoryId)` per link
- `retrieval/shared-background.ts:307` — `getById(id)` per candidate id

**Finding M4 — HIGH performance on profile/social turns:** Contact profile access with dozens/hundreds of `sourceMemoryIds` multiplies full authorization SQL. Correctness is good (each lookup is subject-gated); cost is bad.

**Fix shape (for a later bead):**

```ts
queryAuthorizedMemorySubjects({
  authorization,
  selector: { kind: 'detail_many', memoryIds }, // or list + id = ANY($1)
})
```

Single predicate evaluation, one round-trip.

---

### 1.5 Admin/list helpers load the entire authorized corpus

**File:** `subject-authorized-store.ts:106–122, 344–356, 378–387`

```ts
async function listAllAuthorized(...) {
  // pages of 500 until total
}
listAdminMemories → listAllAuthorized → filter in JS → slice
getMemoriesByChannel → listAllAuthorized → filter by sourceRef prefix
getStats → listAllAuthorized → aggregate in JS
```

**Finding M5 — MEDIUM performance:** Garden privacy summary / admin list / channel memory helpers are O(all authorized memories) in the agent process. Fine at small corpus; painful as L2 grows. SQL-side aggregation already exists for some admin privacy paths on the raw store (`getAdminMemoryPrivacySummary` SQL in postgres-store) but the subject proxy reimplements via full pull.

---

### 1.6 Subject-auth Proxy fallthrough

**File:** `subject-authorized-store.ts:602–603`

```ts
const value = Reflect.get(target, property, target);
return typeof value === 'function' ? value.bind(target) : value;
```

Methods **not** explicitly wrapped pass through to the **raw** store, including:

- `listScratchpadEntries` / `getScratchpadEntry` / `addScratchpadEntry` / …
- `recordPatchEvent`
- any future port method someone forgets to wrap

Scratchpad is companion-private working memory (not cross-contact subject data), so current tool wiring may be intentional. The pattern is still **fail-open by omission**: new `MemoryStorePort` methods are raw until someone remembers to proxy them.

**Finding M6 — MEDIUM maintainability / latent isolation risk:** Proxy should default-deny unknown methods (or use an explicit allowlist facade type), not `Reflect.get` fallthrough.

Subject classification on writes and the authorized SQL predicate are actually strong when used — `FOR UPDATE` + authorize-all-or-throw on mutations (`postgres-store.ts:1028–1050`) is excellent.

---

### 1.7 What product retrieval actually does (good news)

When wired with `enforceSubjectAuthorization: true`:

1. `productMemoryStore(canonicalContactId)` wraps the store (`retrieval.ts:301–309`).
2. Turn semantic search: `productMemoryStore.searchByEmbedding` → authorized SQL with limit (`retrieval.ts:1049–1054`).
3. Lexical fallback: authorized text search uses `search_vector @@ plainto_tsquery` (`subject-queries.ts` text_search case) — **not** the raw in-memory scorer.
4. No contact + non-internal context → authorization undefined → empty results (fail closed).

**Finding M7 — positive:** Subject isolation on the main recall path is real SQL, not a cosmetic filter after leaking rows.

---

## 2. Fleet / SSO / multi-companion (kube direction)

### 2.1 Request capability design (deep read)

`request-capability.ts` is not cosmetic:

- Signed claims: `companion_id`, method, path, query, action, resource digests, body digests, authority version vector, jti/exp
- Auth context frozen into the capability (principal, contact binding, role, session assurance) — comments explicitly forbid reconstructing authority from Garden headers
- `target.resource.companionId !== target.companionId` rejected (`:708` area)
- Replay port with digest equality (`request-capability-replay.ts`)

`fleet-sso-router.ts`:

- Companion-scoped upstream selection
- JIT step-up grant consumption with principal/session/assurance checks (`timingSafeStringEqual`)
- `assertAllowedContext` binds action + companion

`garden-route-authorization.ts`:

- Subject-bound session routes use `subjectRelation: 'self_or_co_subject'`
- Sensitive ops require `webauthn_uv` + explicit confirmation + approvals

**Finding F1 — positive:** Fleet SSO is the real auth story and it is serious. First-pass Garden token finding does not describe your kube end-state.

### 2.2 Gateway agent identity

`server.ts` `enforceCompanionFrameIdentity` (`:1729+`):

- Unidentified → only `gateway.client.identify`
- Role matrix agent vs internal_session_integrity
- Multi-companion: claim ≠ bound companion → disconnect + audit
- Shard workload binding fail-closed (`resolveShardWorkloadForGatedDispatch`)

`companion-auth.ts`: HMAC token over companionId + role, timing-safe verify.

**Finding F2 — positive:** Multi-companion RPC identity spoofing is treated as a disconnect-level event, not a soft log.

### 2.3 Tenant schema isolation

`runtime-factory.ts` + `createPostgresPool({ schema, role })`:

- Per-companion `search_path` pin
- Shared schema only for multi-companion presence / social pot / arbiter
- `assertSharedSchemaRuntimeAuthority` when multi-companion

**Finding F3 — positive:** Personal companion state is schema-scoped, matching charter law 35 directionally.

---

## 3. CogSec (shadow-aware deep read)

Shadow as intentional rollout: accepted.

What the code actually does in shadow:

| Layer | Shadow behavior | Enforce behavior |
|---|---|---|
| Screening | Creates envelopes, journals | Same + can quarantine/withhold |
| Sink gates | Evaluate + audit; `allowed` always true | Honors deny |
| Prompt assembly gate (`intake-sink-gating.ts`) | Does not rewrite content; logs marking plans | Withholds / marks |
| Memory writer | Evaluates `memory_write` sink; still records provenance refs | Can block write |

**Finding C1 — rollout risk (not a bug):** Content recorded under shadow keeps original text. Switching to enforce later relies on **read-time** prompt gate + metadata. That path exists and is documented in code comments (`intake-sink-gating.ts:7–10`). When you flip enforce, re-verify:

1. Historical L0 entries with intake metadata withhold correctly.
2. Entries **without** metadata take the sink’s `unscreened` policy (owner-file explicit — good).
3. Memory rows written in shadow with only soft gates still have subject classification.

**Finding C2 — positive:** Failures in L2 screener map to explicit actions (`quarantine` / `l1_labels_only`) — no silent pass option in the type system.

---

## 4. Session L0 (deeper than “JSONL exists”)

- Segment roll at 16 MiB (`L0_SESSION_FILE_MAX_BYTES`)
- Cross-process write locks for journal and channel index
- Journal chain runtime detects concurrent mutation (“changed repeatedly while reading”)
- Attribution forgery neutralization remains strong (first pass still stands)

**Finding S1 — residual:** `readJsonLines` still full-file read/split per segment. Bounded by roll size, but rebuild/repair paths that walk all segments remain heavy. Not a correctness bug given locks.

---

## 5. Other deep performance notes

| Path | Issue |
|---|---|
| Authorized embedding CTE | `MATERIALIZED` + distance sort + subject EXISTS — plan quality matters; worth `EXPLAIN (ANALYZE)` on a live corpus |
| Embedding serialized as `embedding::text` in many SELECTs | Text decode cost on hot paths; authorized search selects embedding text even when caller may not need vectors back |
| Vision / social `Promise.all` maps | Unbounded concurrency on attachment counts / link sets |
| Full Map hydration includes deleted/superseded rows | Map holds them; many readers filter in JS |

---

## 6. Revised priority list (fleet/kube world)

### Worth beads soon

1. **M2** — Add HNSW (or ivfflat) index on `l2_memories.embedding` with documented ops class matching distance metric; re-check authorized query plan.  
2. **M4** — Batch authorized detail fetch (`id = ANY($1)`) for profile/social/shared-background.  
3. **M1** — Long-term: stop full embedding hydration (or make it lazy / LRU); keep metadata mirror if needed for lexical tools.  
4. **M5** — Admin stats/privacy via SQL aggregates under subject predicate, not `listAllAuthorized`.  
5. **M3** — Add SQL `LIMIT` to raw `searchByEmbedding`; consider asserting `enforceSubjectAuthorization` in production composition only (already true) + fail tests if false.  
6. **M6** — Subject proxy default-deny unknown methods.

### Not bugs given your direction

- Garden shared-token optional auth (non-fleet)  
- CogSec shadow default during soak  
- God-file size (debt, not defect)

### Already in good shape (do not thrash)

- Fleet SSO capability binding + replay  
- Multi-companion gateway identity  
- Per-companion Postgres schema pin  
- Product recall subject SQL  
- Mutation authorize-all-or-throw with `FOR UPDATE`  
- SSRF redirect revalidation (first pass still valid)

---

## 7. Honest scope of *this* deep dive

Went deep on:

- Memory store + subject policy SQL + retrieval wiring  
- Subject proxy semantics  
- Fleet SSO / request capability / gateway companion identity  
- CogSec sink + prompt assembly behavior under shadow  

Still not fully deep-dived (next passes if wanted):

- Contact lifecycle authority + Discord evidence chain end-to-end  
- ICP autonomy permit state machine races  
- Speaking arbiter / social pot concurrency under multi-agent rooms  
- Episodic L0.1 synthesis correctness  
- Backup/restore fleet-auth family edge cases  
- Admin-ui Svelte data handling  

---

## 8. Bottom line

You’re right about the first pass: it over-weighted deploy-shape concerns you’re already moving past (Garden bind, shadow rollout).

The **real** technical debt that falls out of a deeper read is **memory system economics**:

- full RAM corpus  
- no ANN index  
- N+1 authorized detail queries  
- admin full-corpus pulls  
- proxy fallthrough  

Isolation *design* is careful. Isolation *cost* will bite first as companions age — before clever bugs do.
