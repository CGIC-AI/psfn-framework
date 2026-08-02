# Agent memory / retrieval systems survey — governed-doc recall for coding lanes

**Purpose.** Evaluate self-hostable memory/retrieval systems for one specific job: giving parallel coding-agent lanes (Codex CLI, Claude-style agents) reliable recall over PSFN governance docs — `docs/PSFN_PROJECT_CHARTER.md` (1,827 lines, 38 laws), its upcoming per-domain law modules, `working_docs/` design notes, and charter-incident history — with per-law provenance, injectable into CLI-assembled task briefs.

**Status of this document.** Research note, not a decision. All external facts fetched 2026-08-02 from primary sources (GitHub repos, official docs, arXiv papers); star/license/push-date numbers pulled live from the GitHub REST API on that date. Verify before relying on anything time-sensitive.

---

## 1. What the problem actually is

This is **not** the problem most "agent memory" systems solve. The mainstream memory systems target *conversational personalization*: extract facts about a user from chat turns, resolve contradictions, inject them next session. Their benchmark evidence (LoCoMo, LongMemEval, ConvoMem) measures exactly that. Our problem is different on every axis:

- The corpus is **authored, versioned, and small** (thousands of lines of markdown, not millions of chat turns).
- Retrieval must be **auditable and deterministic-adjacent**: a retrieved law must cite its module/law ID; silent LLM "fact extraction" over the charter would *destroy* provenance, not preserve it.
- Writes are **git commits**, not agent chatter. There is no extraction problem to solve — the text is already canonical.
- Consumers are **non-conversational CLI lanes** receiving a one-shot brief, not long-lived chat agents.

Any system whose core value is an LLM extraction/update pipeline over conversation turns is solving a problem we do not have, at per-turn LLM cost, with provenance loss as a side effect. Keep that filter in mind for every candidate below.

Existing PSFN facts that shape the answer (anchored to repo):

- Postgres 17 + pgvector is already the runtime persistence layer (`src/persistence/runtime-factory.ts`, "Postgres-only runtime persistence" per `AGENTS.md`).
- Beads already carry `system:<system>` labels (memory, session, scheduler, cogsec, ...) — a ready-made domain routing key.
- Briefs are assembled by scripts; injection point is a file-read away.
- Local model infra exists (`models/gguf`, `models/transformers`, `docker/Dockerfile.emosim`) — local embeddings are in-family.

---

## 2. Candidates

### 2.1 Mem0 (mem0ai/mem0)

- **What it is:** A memory layer that runs an LLM pipeline over conversation turns: extraction phase pulls "salient memory candidates" from recent messages + a running summary; update phase retrieves similar existing memories by embedding and an LLM decides ADD/UPDATE/DELETE/NOOP. Retrieval is embedding top-k, plus (new algorithm, April 2026) BM25 + entity-linking fusion. Sources: [repo README](https://github.com/mem0ai/mem0), [paper, arXiv:2504.19413](https://arxiv.org/abs/2504.19413).
- **Deployment:** Python (`pip install mem0ai`) or npm SDK; self-hosted server is Docker Compose — [their own blog](https://mem0.ai/blog/self-host-mem0-docker) describes three containers: API, Postgres+pgvector, Neo4j. Vector store pluggable (Qdrant, pgvector, ...).
- **License:** Apache-2.0. **Maturity:** 62.3k stars, pushed daily, heavily maintained.
- **Cost/latency profile:** Requires an LLM for *every* write (`gpt-5-mini` default per README); the README itself admits the benchmark numbers come from "the managed platform, which includes proprietary optimizations not available in the open-source SDK." Defaults point at OpenAI APIs; local LLM possible but the pipeline quality is tuned for frontier models.
- **Fit for PSFN: poor.** The entire pipeline — LLM fact extraction, contradiction resolution, user/session/agent scoping — is chatbot personalization machinery. Feeding the charter through `memory.add()` would let an LLM paraphrase laws into "memories," severing the link to law IDs. We'd use ~5% of the system (a vector search over text) and pay for a Neo4j we don't need.

### 2.2 Zep / Graphiti (getzep/zep, getzep/graphiti)

- **What it is:** Zep is the (now cloud-first) memory platform; Graphiti is the open-source engine at its core: a temporal knowledge graph where facts are entity→relation→entity triplets with **bi-temporal validity windows**, and every derived fact traces back to an "episode" (raw ingested data). Retrieval is hybrid: semantic + BM25 + graph traversal, no LLM on the read path. Sources: [graphiti repo](https://github.com/getzep/graphiti), [Zep paper, arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [Zep graph docs](https://help.getzep.com/graph-overview).
- **Deployment:** Graphiti is self-host-only Python, but **bring-your-own graph database** (Neo4j or FalkorDB) — per the repo's own Zep-vs-Graphiti table. Zep proper is "fully managed or in your cloud" on a proprietary graph engine; the old OSS `getzep/zep` server (4.8k stars) is the legacy line.
- **License:** Apache-2.0 (both repos). **Maturity:** graphiti 29.5k stars, pushed daily — genuinely active.
- **Cost/latency:** Write path is the expensive one — LLM entity+relation extraction plus bi-temporal stamping per episode. Read path is cheap (traversal + RRF, no LLM).
- **Fit for PSFN: over-engineered now, one feature worth remembering.** The genuinely relevant idea is **bi-temporal fact invalidation with episode provenance** — that maps beautifully onto "charter law X was revised in commit Y; what did the lane see when it caused incident Z?" But standing up Neo4j/FalkorDB + an LLM ingestion pipeline to track an 1,800-line document that already lives in git (which *is* a bi-temporal store with provenance) is duplicating git with worse tooling. Revisit only if incident-history queries outgrow SQL-over-git-log.

### 2.3 Letta / MemGPT (letta-ai/letta)

- **What it is:** Not a memory layer — a **full agent runtime** implementing the MemGPT paper's OS-style virtual context: memory as named blocks (`persona`, `human`, archival vector store, recall store), with the *agent itself* calling tools to page memory in and out. Sources: [repo](https://github.com/letta-ai/letta), [MemGPT paper](https://arxiv.org/abs/2310.08560).
- **Deployment:** In transition. The repo README states active development moved to the **Letta Agent repo**; the legacy server is maintenance-mode, and the current shape is **Letta Code** — a local CLI agent (Node.js 22.19+, `npm i -g @letta-ai/letta-code`) plus a TypeScript Agent SDK that runs fully locally. Memory state persists in Postgres/SQLite.
- **License:** Apache-2.0. **Maturity:** 24k stars, active, but mid-pivot (V1 API → Agent SDK), which is a migration-risk signal for any adopter.
- **Fit for PSFN: architectural non-starter.** Its memory is self-managed *by the agent inside Letta's own agent loop*. PSFN lanes run in Codex CLI / Claude harnesses; adopting Letta means replacing the harness, not adding a library. Worth tracking for a different reason: Letta Code is a local-first, memory-native coding-agent CLI — potentially relevant to future lane-runtime work, irrelevant to governed-doc recall.

### 2.4 Cognee (topoteretes/cognee)

- **What it is:** Python "memory platform for agents": ingestion pipeline (`cognify`) chunks docs, runs **LLM-driven knowledge-graph construction** (ontology generation, entity/relationship extraction) layered over vector embeddings; query via graph reasoning + semantic search. Sources: [repo](https://github.com/topoteretes/cognee), [paper by the team](https://arxiv.org/abs/2505.24478).
- **Deployment:** pip/uv, Python 3.10–3.12, pluggable vector/graph/relational stores; Docker images exist. **Requires an LLM API key for the build pipeline** (README quickstart sets `LLM_API_KEY`).
- **License:** Apache-2.0. **Maturity:** 29.7k stars, very active (630 open issues — both popularity and support-load signal).
- **Fit for PSFN: poor.** The differentiating machinery — emergent ontology, LLM graph construction, "memory across sessions" — is precisely what a curated charter corpus does not need; an LLM-derived ontology over 38 hand-written laws is a provenance-losing paraphrase layer. Also imports a Python service into a Node 22/TypeScript stack. Chunk-level citation of law IDs would have to be rebuilt on top anyway.

### 2.5 LangMem (langchain-ai/langmem)

- **What it is:** A small library of **memory primitives**, not a service: functions to extract/update memories from conversations, agent-callable manage/search memory tools, a background memory manager — storage-pluggable but designed around LangGraph's Store. Sources: [repo](https://github.com/langchain-ai/langmem), [conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/).
- **License:** MIT. **Maturity:** 1.6k stars — an order of magnitude smaller community than everything else here; pushed 2026-07-25, maintained but minor.
- **Fit for PSFN: no.** Primitives for *conversational* memory inside LangGraph agents. PSFN uses neither LangGraph nor conversational memory. Nothing here does governed-doc retrieval.

### 2.6 supermemory (supermemoryai/supermemory)

- **What it is:** TypeScript "memory and context engine": hybrid RAG + memory in one query, user profiles, connectors, and — relevant here — **document ingestion with chunking and search**. Sources: [repo](https://github.com/supermemoryai/supermemory).
- **Deployment:** Genuinely local-first option: single binary (`npx supermemory local`), data in one `./.supermemory` dir, **local embeddings by default** (`Xenova/bge-base-en-v1.5`, no API key), fully offline against Ollama, same API as their cloud. MIT license. 28.7k stars, TypeScript, pushed daily. MCP server + open-source plugins for Claude Code/OpenCode.
- **Fit for PSFN: the strongest "buy" candidate, with caveats.** It would give doc recall + MCP access for Claude-flavored lanes with near-zero code. Caveats: (a) its differentiating value (user profiles, contradiction resolution, auto-forgetting) is conversational memory we don't need; (b) chunk-level provenance back to law IDs depends on its metadata handling — unverified, needs a spike; (c) adopting a fast-moving (28.7k-star, daily-push) platform as a dependency conflicts with "must not become a heavy platform dependency." Reasonable as a *spike* if the DIY path stalls; not the first move.

### 2.7 txtai (neuml/txtai)

- **What it is:** Apache-2.0, 12.8k stars, Python, single-author-maintained (NeuML). All-in-one **embeddings database**: local ANN + BM25/sparse + SQL + optional graph, runs fully in-process, zero external services. Sources: [repo](https://github.com/neuml/txtai).
- **Fit for PSFN: capable but wrong runtime.** As a retrieval engine it fits the doc-recall job well (local embeddings, hybrid search, no LLM needed). But it means running a Python service/library alongside the Node brief-assembly scripts to duplicate what pgvector + tsvector already do in the existing Postgres. Only interesting if the stack were Python.

### 2.8 A-MEM (WujiangXu/AgenticMemory, A-mem-sys)

- **What it is:** Research system (arXiv:2502.12110, 900+ citations): Zettelkasten-style agentic memory — each memory becomes a structured note (context, keywords, tags) that an LLM dynamically links to existing notes, with "memory evolution" (old notes get rewritten as new ones arrive). Sources: [paper](https://arxiv.org/abs/2502.12110), [A-mem-sys repo](https://github.com/WujiangXu/A-mem-sys).
- **License:** MIT, 376 stars, last pushed 2026-03 — research code, not a maintained platform.
- **Fit for PSFN: read the paper, don't run the code.** "Memory evolution" — silently rewriting stored knowledge — is the *opposite* of what governance recall needs; laws must be immutable except by git commit. The note-linking idea is a decent mental model for organizing incident history, nothing more.

### 2.9 DIY baseline: pgvector / sqlite-vec over chunked markdown modules

- **What it is:** Split charter into per-domain modules with stable law IDs; chunk by law/section (structure-aware, not token-window); store `chunk_text, law_id, module, git_sha` plus embedding in **pgvector** (already deployed, [PostgreSQL-licensed extension](https://github.com/pgvector/pgvector), 22.4k stars); hybrid retrieval = `tsvector` BM25-style keyword + cosine, fused in SQL. Embeddings from a local model (stack already runs local models). For a zero-dependency file-based variant, [sqlite-vec](https://github.com/asg017/sqlite-vec) (Apache-2.0, 8k stars, pure-C extension, Node bindings via `npm install sqlite-vec`) — note its own README warns it is pre-v1 with breaking changes expected.
- **Cost/latency:** Embeddings computed once per doc change (CI hook), not per query. Query = one SQL round-trip, single-digit ms at this corpus size. No LLM anywhere in the loop.
- **Provenance:** Total — law ID is a column, and `git_sha` pins the exact charter revision retrieved.
- **Fit for PSFN: this is the substrate to build on** (see §4).

### 2.10 Honorable mention: basic-memory (basicmachines-co/basic-memory)

Markdown-files-as-memory with SQLite indexing and an MCP server; local-first; but **AGPL-3.0**, 3.5k stars, and aimed at chat-assistant note-taking. License friction + conversational orientation → noted for completeness, not recommended.

---

## 3. Is semantic vector retrieval even the right tool here?

Partially. The honest decomposition of the recall problem:

1. **"Which laws govern this task?"** — This is a **routing** problem, not a search problem. PSFN beads already carry `system:<domain>` labels (`AGENTS.md` mandates them), and the charter is being split per-domain. A hand-maintained `domain → law-module` routing table resolves the common case with *zero retrieval machinery*: fully deterministic, auditable in review, testable in CI ("every system label maps to ≥1 module"), and impossible to silently drift the way embedding recall can. Deterministic injection also composes with the existing hardcoded-settings/settings-contract gates — the mapping is reviewable config, not model behavior.
2. **"What past incidents look like this one?"** — This *is* a search problem: fuzzy, cross-cutting, vocabulary-mismatched ("the lane bypassed intake again" vs. law wording). Embedding similarity over an incident log + working_docs is the right tool. Volume is low (hundreds of entries), so pgvector in the existing Postgres is trivially sufficient; no dedicated vector DB.
3. **"What changed since this lane's brief was built?"** — git already answers this. Temporal knowledge graphs (Graphiti) replicate git at LLM cost for a corpus that lives in git.

So: **deterministic injection as the primary path; vector retrieval as the secondary, cross-cutting layer.** Vector-first would mean every brief depends on embedding recall quality for content whose correct answer is already known statically — nondeterminism purchased for no gain. The vector layer earns its keep exactly where determinism can't reach: incident similarity and working-docs discovery.

Secondary benefit of injection-first: **evaluability.** "Lane for a `system:cogsec` bead must have cogsec law module in brief" is a CI-assertable invariant. "Vector search returned the right law" is a recall metric you'd have to build a harness to even measure.

---

## 4. Recommendation for PSFN

**Phase 0 — substrate (no new dependencies).** Split the charter into per-domain law modules with stable IDs (`law:<domain>-<nn>`). Build the `system:*`-label → module routing table as versioned config (owner-file contract, since it's mutable policy). Brief-assembly scripts read routing table → inject module files verbatim, with law IDs intact. Provenance is free; cost is zero; every lane gets the exact laws, not an LLM's summary of them.

**Phase 1 — recall layer (pgvector in existing PG17, ~one Node script + one table).** Index law modules + `working_docs/` + a structured **charter-incident log** (new artifact: one record per incident — law violated, bead, lane, commit, one-paragraph narrative). Local embedding model from the existing model infra; hybrid `tsvector` + cosine query; results rendered into briefs as `law:<id> @ <git_sha>` citations. Index rebuild on git hook/CI. This covers cross-cutting and incident-history recall without any new service.

**Phase 2 — only if evidence demands it.** If incident-history queries start needing "what was true when" reasoning beyond `git log` + SQL timestamps, evaluate Graphiti as a *dedicated incident-graph* (not charter-graph) — its bi-temporal provenance model is the one genuinely differentiated capability found in this survey. Do not adopt Mem0, Letta, Cognee, or LangMem for this use case at any phase: each one's core machinery is conversational personalization or agent-runtime ownership that PSFN neither needs nor can absorb without harness replacement. supermemory-local is the fallback "buy" option if Phase 1 stalls and MCP-native access for Claude lanes becomes a hard requirement — spike its chunk-metadata provenance first.

Explicit non-goals: no Neo4j/FalkorDB, no LLM in the retrieval or ingestion path, no per-turn memory writes, no user-profile machinery.

---

## 5. Comparison table

| System | What it is | Self-host | License | Runtime | LLM in loop | Provenance to law ID | Fit for PSFN |
|---|---|---|---|---|---|---|---|
| Mem0 | LLM fact-extraction memory layer for chat | Docker: API + PG/pgvector + Neo4j | Apache-2.0 | Python (npm SDK) | Every write (default OpenAI) | Lost — LLM paraphrases laws into "memories" | Poor — personalization machinery, ~5% used |
| Zep (cloud) / Graphiti (OSS) | Bi-temporal knowledge graph, episode provenance | Graphiti self-host, BYO Neo4j/FalkorDB; Zep managed | Apache-2.0 | Python | Every ingest episode | Episodes traceable, but git already does this | Overkill now; revisit for incident temporality |
| Letta (MemGPT) | Full agent runtime, agent-self-managed memory blocks | Yes (Postgres/SQLite); pivoting to local CLI | Apache-2.0 | Python → Node (Letta Code) | Memory paging is agent tool calls | N/A — replaces the harness | Non-starter — wrong layer |
| Cognee | LLM-built KG + embeddings "memory platform" | pip/Docker, pluggable stores | Apache-2.0 | Python | Entire `cognify` build pipeline | LLM-derived graph over laws = paraphrase | Poor — solves extraction we don't have |
| LangMem | Memory primitives for LangGraph | Library only | MIT | Python | Extraction calls | No doc-citation model | No — wrong ecosystem, wrong problem |
| supermemory (local) | Hybrid RAG+memory engine, single binary | Yes — one binary, local embeddings, offline-capable | MIT | TypeScript | Extraction (optional; Ollama-offline) | Unverified chunk metadata — needs spike | Best "buy" fallback; platform-dependency risk |
| txtai | In-process embeddings DB, hybrid search | Yes, fully embedded | Apache-2.0 | Python | None required | Manual (metadata columns) | Capable, wrong runtime for PSFN |
| A-MEM | Zettelkasten agentic memory (research) | Research code | MIT | Python | Linking + note "evolution" | Actively hostile (rewrites stored notes) | Paper only, not code |
| **pgvector / sqlite-vec DIY** | Structured chunking + hybrid SQL retrieval | Already deployed (PG17) | PostgreSQL / Apache-2.0 | Node-native (pg client) | None | Total — law ID + git_sha are columns | **Recommended substrate** |

Data sources: GitHub REST API (stars/licenses/push dates, 2026-08-02) and the per-candidate repo/doc URLs cited in §2.
