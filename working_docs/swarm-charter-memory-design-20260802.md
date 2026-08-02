# Swarm charter memory — by-domain + global, cross-harness design (2026-08-02)

Design note, not a bead. Companion to `agent-memory-systems-survey-20260802.md`
(the "why not Mem0/Zep/Letta" evidence). This is the "what we actually build."

## Problem

Parallel coding lanes (Codex CLI, Claude Code, Kimi Code, pi-agent) cause
charter incidents because no lane holds the charter. The operator is the only
replication layer, and he is one (1) wetware unit. The fix must work across
all four harnesses without per-harness reimplementation, must preserve law-ID
provenance, and must not add a platform dependency.

## Shape: two layers, one artifact family

Everything below is **files + one CLI**. No service, no server, no LLM in any
retrieval path. The universal floor — readable markdown and a shell command —
works in every harness including ones that don't exist yet.

### Layer 0: the corpus (prerequisite, shared with the charter reorg)

- Split `docs/PSFN_PROJECT_CHARTER.md` into per-domain law modules under
  `docs/charter/` with stable IDs (`law:<domain>-<nn>`). Law text moves
  byte-identically; a CI check hash-pins that no law text changed in the
  split. The monolith stays as the generated, concatenated view (or is
  retired in favor of an index page — decision for the reorg bead).
- One **global core module**: the laws that bind every lane regardless of
  domain (fail closed, honest internals, no fabricated state, owner-file
  authority, split-runtime shape). Small enough to fit in any brief.
- `config/charter-routing.json` (owner-file contract): `system:*` bead label
  → law modules. Reviewable config, not model behavior. CI invariant: every
  legal `system:*` label maps to ≥1 module, and every module is reachable
  from ≥1 label.

### Layer 1: deterministic injection (the incident-stopper)

Brief assembly becomes, for every harness:

```text
brief = task brief
      + global core module (always)
      + domain module(s) from the bead's system:* labels (always)
      + ≤3 incident digests from the recall layer (when they exist)
```

Injection is **verbatim file inclusion** — law text with IDs intact, never an
LLM summary. Per-harness delivery:

| Harness | Delivery |
|---|---|
| Codex lanes | existing companion-script brief files + `AGENTS.md` pointer |
| Claude Code | brief file + `CLAUDE.md`/skill pointer |
| Kimi Code | brief file + project skill pointer |
| pi-agent | prompt-registry/composition injection at spawn |

All four read the same module files. The harness-specific part is a pointer,
not a parallel implementation. MCP server is a **later optional** ergonomic
for harnesses that support it; the floor stays files.

### Layer 2: recall (fuzzy, cross-cutting — where cass earns its keep)

Two recall surfaces, both already-running or trivial:

- **Incident + lane-history recall: `cass`.** Already installed (0.6.22),
  already indexes coding-agent session histories across harnesses, has a
  semantic index component, and exposes `cass search` / `cass pack` (agent
  handoff packs) plus `cass capabilities` for agent self-onboarding. The new
  artifact is a **charter-incident log** (`working_docs/charter-incidents/`
  or a jsonl — one record per incident: law ID, bead, lane, commit,
  one-paragraph narrative) written in the same directories cass already
  watches, so "have we been burned by this before?" becomes a `cass search`
  at brief-assembly time instead of the operator's 2am memory.
- **Doc recall: pgvector in the existing PG17** (Phase 1 from the survey):
  one table, one Node indexer script, local embeddings from existing model
  infra, hybrid `tsvector` + cosine over law modules + `working_docs/`.
  CLI front-end (`scripts/charter-recall.ts`) so any harness can run it via
  shell. Only build this if cass's semantic index doesn't already cover
  doc-shaped corpora well — check first, cass may eat this layer too.

Explicit non-goals (from the survey): no Neo4j/graph DB, no LLM extraction
over the charter, no conversational-memory platform, no per-turn writes.

### Layer 2 gaps found on first contact (2026-08-02)

Measured against live `cass` 0.6.22 on the operator box:

- **Kimi ingestion was broken in practice — FIXED 2026-08-02.** cass 0.6.22
  listed a `kimi` connector but indexed zero kimi conversations
  (`~/.kimi-code/sessions/` undetected). Upstream v0.6.23 (2026-07-31)
  shipped "the current Kimi Code layout" connector (#351); updated the
  local binary (checksum-verified, old binary at
  `~/.local/bin/cass-0.6.22.bak`) and `cass diag` now detects the kimi path.
  Standing audit rule stays: "connector listed" ≠ "sessions indexed" —
  `cass stats` is the check, per harness.
- **Index was 5 days stale.** cass has `cass index --watch` (30s scan
  interval default) — it was simply never daemonized. Fix when back on the
  Linux server: systemd user unit running `cass index --watch`. Parked, not
  forgotten.
- **Semantic index absent** — requires `cass models install` (a model
  download, needs operator consent) then `cass index --semantic`. Lexical
  search works without it; semantic is the upgrade, not the floor.
- **Discovery is per-harness wiring, not a cass feature** — see the delivery
  matrix below. Without pointers, recall exists and nobody uses it — which
  was the state on 0.6.22.

## Delivery mechanisms: three jobs, three mechanisms (decision 2026-08-02)

"Hooks or MCP?" is a false fork. Each mechanism owns the job it fits:

| Job | Mechanism | Why |
|---|---|---|
| **Always-on law text** (global core module, routing table, "use cass" pointer) | **AGENTS.md** | Claude Code, Codex, and Kimi Code all auto-load AGENTS.md into context. Passive beats active for text that must never be missed: no agent action required, zero new infrastructure. Per-domain modules still ride brief-assembly scripts. |
| **Agent-initiated recall** (incident history, past-lane search) | **MCP server** | Mid-task search is a tool call; MCP is the right shape. Thin wrapper over `cass search` / `cass pack` (and the charter-recall CLI if built). Claude, Kimi, and Codex all speak MCP. pi-agent is our own runtime: native tool in its registry instead, no MCP wrapper. One server, three harnesses, one native tool. |
| **Automation / enforcement** (index freshness, future hard gates) | **Hooks** | SessionStart hook (Claude + Kimi support them) or the systemd `--watch` unit for index freshness. Future home of hard enforcement, e.g. blocking edits to sensitive paths when the matching law module isn't in the brief — a block, not a hope. |

The pre-decision failure mode was using none of the three deliberately:
recall existed, nothing pointed at it, and the index went stale on the
honor system.

## Coordination layer: agentbus (adopted in principle 2026-08-02)

[`Federated-Industrial-Laboratories/agentbus`](https://github.com/Federated-Industrial-Laboratories/agentbus)
— append-only per-run JSONL message bus for multi-agent work: findings with
mandatory provenance (`computed | fetched | recalled | testimony`),
corrections-as-new-messages, validate-before-append, a selectable local
vector lane where vectors are strictly derived indexes (never canonical),
stdlib-only Python CLI tools, Apache-2.0. Claude Code installer adapter,
Codex AGENTS.md snippet, host-agnostic fallback ("agent can run a shell
command and read a Markdown file") covers Kimi and pi-agent.

Why it belongs in this design:

- **It is the correct home for the charter-incident log.** A long-lived
  incident bus file beats a flat jsonl: linting, provenance classes,
  corrections, semantic dedup, and a native viewer come with it. Common
  fuckups become queryable *and* shareable mid-run.
- **It attacks the collision class of bug, not just the ignorance class.**
  Parallel lanes duplicating findings and returning transcripts instead of
  claims was the pre-file-isolation pain of the multi-lane waves; a shared
  bus gives lanes a claims ledger so coordination is structural, not
  brief-writer heroics.
- **Doctrine alignment:** derived-never-canonical vectors, recalled never
  passing as computed, append-only corrections — the charter's own memory
  ethics. (The author has repo access; pattern convergence is acknowledged
  and flattering per the operator.)

Boundaries stay as designed: agentbus is **intra-run coordination**;
cass is **cross-session search**; AGENTS.md injection is **always-on law
text**. Three layers, no overlaps, no replacements.

Spike plan before any adoption bead: clone, `bus-lint` the example run,
run one real two-lane task on it, then decide whether the incident log is
authored directly as a bus file or mirrored into one.

**External review (GPT Pro, 2026-08-02, reported upstream by operator):**
concurs with the evidence-plane framing — adopt as the **evidence ledger
beside Beads/Git/CI**, never the orchestration control plane ("the bus
records coordination; it does not perform orchestration"). Defects worth
tracking: (a) TOCTOU race in `bus-append` — read/allocate/validate/append
is not transactional; fix is an exclusive `flock` over the whole op plus a
full-write loop (severity for PSFN is low: one-worker-one-bead discipline
plus unique per-lane agent names already shrinks the window, but fix
upstream); (b) provenance is self-attestation — the review's proposed
second axis, verification state
(`unverified|observed|reproduced|independently_verified`) with
provenance-dependent schema rules, is worth stealing outright and matches
PSFN's own observed/reported/inferred epistemic posture; (c) correction
model has no first-class `supersedes`/`retraction`/`resolution` event —
the spike hit this (refs convention only); (d) vector identity omits the
model revision/digests at the *sidecar* level (install-time pinning exists;
propagation is the gap) and accepted vectors aren't norm-checked; (e)
sizing rule: one run per story/defect/review cycle, never one immortal
bus file — appends are O(n) with O(n²) aggregate. Empirical confirmation
this session adds what the static review could not: suite executed 120/120
and documented vector separation numbers reproduced to three decimals.

**Spike results (2026-08-02, clone at `~/agentbus`, HEAD a285057):** PASS.
Example lints clean; validate-before-append genuinely refuses malformed
messages (rank without `re`/`basis`, note without `text`, finding whose
body id doesn't match the auto-assigned message id) with named errors and
zero partial writes. Incident-ledger pattern exercised end to end:
finding → rank with basis → note → superseding finding linked via `refs`,
`bus-lint` green throughout, `cost` closes the record. Vector lane:
venv-isolated deps (`~/.venvs/agentbus`, repo stays pristine — a repo-local
venv trips their whole-tree register lint), `bus-model fetch` pinned to
revision `1110a243`, `bus-embed test` reproduces the documented separation
(+0.808 paraphrase / +0.129 unrelated, 430 s/s on this box), and `near`
queries route correctly ("rules never shown" → the charter-incident
finding; "claims support but does nothing" → the cass-connector findings;
the superseded duplicate surfaces alongside its correction, which is the
right behavior for an audit trail). Tool suite 120/120 OK. Open item:
one real two-lane task before the adoption bead.

## Why this stops incidents specifically

- Incidents happen when a lane *never saw* the law. Injection guarantees
  sight — deterministically, auditable in the brief file itself, CI-testable
  ("cogsec bead brief contains cogsec module").
- Repeat incidents happen when the lesson lives in one operator's head. The
  incident log + cass makes the lesson a query.
- Provenance survives because law text is injected verbatim with IDs and the
  routing table is reviewable config — an incident review can diff exactly
  what the lane was shown.

## Sequencing (natural bead boundaries)

1. Charter split into modules + hash-pin CI (pure refactor, zero semantics).
2. Routing table + brief-assembly injection (scripts + owner file).
3. agentbus spike (clone, lint example, one real two-lane task) → then
   incident-log-as-bus + backfill the known incidents + cass watch wiring.
4. (Conditional) pgvector doc-recall CLI — only if cass doesn't cover docs.

Each ships independently; each reduces incident rate on its own.
