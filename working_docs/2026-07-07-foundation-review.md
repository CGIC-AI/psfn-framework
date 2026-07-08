# Foundation Review — foundation_e0_e2 → main

**Date:** 2026-07-07 (overnight run, requested 2026-07-06)
**Status:** UNTRACKED working doc (working_docs/ is gitignored — verified this file does not appear in `git status`)
**Method:** Five parallel Opus deep-review agents (companion core, memory/faculties/persistence, gateway/boundary, public-release hygiene, docs drift) plus a Codex peer pass on the companion core, per the orchestration workflow. Every finding below was verified against source with file:line evidence by the reviewing agent; items I re-verified myself are marked ✔︎.
**Purpose:** foundation for (1) the docs-update sprint, (2) next-sprint planning after foundation_e0_e2 merges to main, (3) the public-release cleanup.

**Bead tracking:** epic + child issues filed under `psfn-framework-????` (see §8; IDs filled in after filing).

---

## 0. TL;DR — the state of the union

- **The charter is winning.** Both the Opus core review and the boundary review came back with the same headline: the harm-vector laws (17–20), the secrets boundary (Law 7), message ontology (whisper vs musing, typed message classes), Law 33 tool consolidation, and your LLM-call-economy lens are *implemented and wired*, not aspirational. No P0 architecture findings anywhere in src/.
- **The code is not slop.** Reviewers went looking for mock fallbacks, swallowed errors, dead wiring, and bullshit tests, and found very little. The real debt is **structural**: a handful of genuine god files (worst: `heartbeat-template-runtime.ts` at 2,629 lines) and a few seams that exist as modules but not as charter-named ports.
- **One real security P1:** the agent (core) process holds the raw Postgres DSN (password embedded), read from env and deliberately allowlisted into the agent's environment by the launcher. It's the single credential that escapes an otherwise-clean stripping seam.
- **The gitignore anger is justified but bounded:** 11 files are tracked that shouldn't be (committed before the ignore rules existed — gitignore never untracks). The worse news is history: names in 146 commits, a Tailscale IP + SSH targets in old blobs, and real personal emails in every commit's metadata.
- **The pivotal good news for going public: full-history secrets scan is CLEAN.** No API keys, no private keys, no tokens, no real `.env`, and **no companion session/transcript data was ever committed**. Nothing in history hands anyone a way in — what leaks is *who runs it and where*.
- **Recommendation for public release: `git filter-repo` rewrite** (mailmap + path removal + string redaction), not just HEAD surgery. Bead traceability survives (IDs are slugs in commit messages, not SHAs — verified ✔︎); the only rewrite casualty is 72 hardcoded CHANGELOG commit links, which can be regenerated. Details §2.
- **No LICENSE file. P0 for public release** — without one, public ≠ usable.
- **Docs:** the inverse of the usual failure mode — almost every charter concept is implemented in code; the gap is documentation. Weighted thoughts, satellite/active-emanation, and CompanionId have zero doc coverage. Four sprint scratch docs live in `docs/`. Two byte-identical charter files.

Reading order if you only have an hour: §2 (public-release plan) → §3 (core) → §4 (gateway P1) → §7 (synthesis + sprint seeds).

---

## 1. The gitignore mess — what actually happened

`.gitignore` has correct rules (`working_docs/`, `history/`, `workspace/`, `data/`…), but git never untracks files that were committed **before** a rule existed. That's the whole mystery. Tracked-but-should-not-be:

| File | Why it's there | Sensitivity |
|---|---|---|
| `working_docs/carlini-kube-upgrade-55be96f8.md` | committed pre-rule | **P0 — Tailscale IP 100.96.206.29, `o_0@` scp targets, remote paths** |
| `working_docs/charge-governed-long-horizon-workers.md` | committed pre-rule | P1 planning doc |
| `working_docs/cubic_review_findings_20260702.md` | committed pre-rule | P1 planning doc |
| `context_packets/2026-06-11-memory-schema-session.md` | committed pre-rule | P1 |
| `data/skills/tools/web-fetch/SKILL.md` | committed pre-rule | P0 — internal hostname `purrsephone.local` |
| `.claude/skills/psfn-live-ops/SKILL.md` | never ignored | **P0 — worst single file: cluster/SSH alias/namespace/NFS/Tailscale IP/username, full live-Pi runbook** |
| `.claude/skills/bead-authoring/SKILL.md` | never ignored | P1 |
| `.claude/agents/deep-reasoner.md` | never ignored | P1 (harmless but non-product) |
| `.github/copilot-instructions.md` | never ignored | P1 — only file in `.github/`; **no workflows exist to preserve** ✔︎ |
| `companion_docs/*` (3 files) | never ignored | P1 — companion-facing personal docs |
| `docs/SPRINT_9_*.md`, `docs/sprint-8-architecture-report.md`, `docs/self-eval-prompt-audit.md` | working docs living in docs/ | P0/P1 — SPRINT_9_CONTINUATION has `ssh psfn-pi`, real emails |

Fix for the tree: `git rm --cached` + extend `.gitignore` with `context_packets/`, `companion_docs/`, `.claude/`, `.github/copilot-instructions.md`. But see §2 — the tree is not the whole problem.

---

## 2. Public-release readiness (hygiene agent, full-history audit)

### The clean bill
Full-history scan across all refs for key/token/PEM/JWT/AWS/GitHub-PAT patterns: **zero hits** beyond placeholders in `.env.example` files. No real `.env` ever committed. **No companion session, transcript, or memory data ever committed** — the crown-jewel worry is unfounded.

### What history does leak (HEAD-only fixes cannot touch this)
1. **Author emails in commit metadata**: `mdf@foxenigne.ai` (66 commits), `v@axailotl.ai` (119), `vega@users.noreply.github.com` (2 — ties handle to name), `ada@LILITH-V.localdomain` (2 — internal hostname).
2. **Tailscale IP + SSH targets** in historical blobs of the carlini-kube doc and psfn-live-ops skill. (CGNAT-range IP, low attack value, but fingerprints the tailnet + username.)
3. **Companion/operator names across 146 commits** — vs the standing "no real names in repo" policy.

### Name inventory at HEAD (97 files)
- 75 are test fixtures using `Vega`/`Purrsephone` as sample names — mechanical, scriptable rename.
- Load-bearing: `deployment/systemd/user/purrsephone-watchdog.*` (name IS the filename; referenced from `docs/operations.md` and `parity-matrix.ts:1000`), `config/concern-softening.json` (regex on the companion's name — behavioral), `data/skills/tools/web-fetch/SKILL.md`, docs prose (`operations.md`, `setup.md`, `attribution.md`, `context-envelope.md`), `src/core/identity/prompt-runtime.ts` docstring examples.

### Public-readiness basics
- **LICENSE: missing, never existed. P0.** Public repo without a license = all-rights-reserved; nobody can legally use or fork it. Pick deliberately (Apache-2.0 vs MIT — Apache-2.0 gives patent grant + explicit contribution terms; fits a framework meant to outlive vendors).
- README: genuinely stranger-fit, honest early-alpha framing. No launch blocker.
- CONTRIBUTING / CODE_OF_CONDUCT: absent (P2).
- `PSFN-Satellite-Hub` references: comments only in `companion-ui/src/lib/protocol/` — no code imports ✔︎. Cosmetic.
- CHANGELOG: 72 hardcoded `github.com/CGIC-AI/psfn-framework/commit/<sha>` links — fine if history stays, **all break under rewrite**; regenerate as part of it.

### The plan (recommended: Option B, filter-repo rewrite)
Beads does NOT anchor raw git SHAs — issue records carry slug IDs only, and commit↔bead linkage lives in commit-message prefixes which filter-repo carries through verbatim ✔︎. So the rewrite's traceability cost is only the CHANGELOG links.

Sequence:
1. **Tree sanitization first** (works for either option): `git rm --cached` the §1 strays; add LICENSE; parameterize live-infra strings in `AGENTS.md`, `docs/operations.md`, `scripts/ops/*.sh`, helm README (`psfn-shard`/`psfn-pi`/IPs/`/home/psfn/...` → env vars or `<HOST>` placeholders); rename `purrsephone-watchdog.*` → `companion-watchdog.*` (+ update the two referencing files); genericize `concern-softening.json` and the 75 test fixtures (scripted).
2. **filter-repo pass** on a fresh clone: `--mailmap` collapsing all authors to one public identity; `--invert-paths` removal of the stray files across all history; `--replace-text` for `100.96.206.29`, `o_0@`, `psfn-shard`, `psfn-pi`, `purrsephone.local`, and the names.
3. Regenerate CHANGELOG from the rewritten log.
4. Coordinated force-push; re-clone everywhere; re-point the `pi-next` remote on the live Pi.
5. Flip public.

Option A (HEAD-only surgery) is cheaper but leaves emails/IP/names permanently exposed in history — insufficient against the standing names policy. The nuclear fresh-cut squash destroys per-commit bead traceability for no gain over filter-repo.

---

## 3. Companion core review (primary focus)

**Verdict: strongly charter-aligned. No P0. The mind is honest.**

### Verified good (the load-bearing stuff)
- **Law 7 (no secrets in core):** zero raw-credential reads in `src/core`; the 6 `process.env` uses are benign (CONFIG_DIR or injectable params). `session/tool-observation-context.ts:289` actively *redacts* credential-like values from tool output. Structural enforcement confirmed end-to-end ✔︎: the split launcher spawns the agent with `env -i` + a curated allowlist (`scripts/start-gateway-agent.sh:128-209`) — no provider keys can reach the agent process, so the `getEnvApiKey` fallback in `resolveProviderApiKey` has nothing to find. The open risk the reviewer flagged (stream-adapter forwarding apiKey) is closed: key resolution is gateway-side only.
- **Laws 17–20 (no fabrication, no fake health):** vision/LLM failure emits an explicitly non-fabricating notice ("I should not pretend I saw the image"), tagged `runtime-fallback`, zero cost (`agent-invocation.ts:332-370`). A previously fake-confident constant was deliberately removed (`observer-sidecar/projection.ts:36`).
- **§8.1 message ontology is typed and real:** `message-classes.ts` — outwardSpeech / musing / systemNote / internalWhisper / compaction / continuity / mirror, with type guards. The whisper→musing rename (charter Phase 4) is **done in code**.
- **Law 33:** canonical tool catalog with per-domain `retiredAliases`; drift guard runs on every `registerTool`; retired aliases filtered from promotion, autoload, suggestion, and search.
- **§6.18:** concern phrasing moved out of code into fail-closed `config/concern-softening.json`.
- **Law 27:** weighted thoughts gate on threshold, preserve accept/decline consent.
- **Hygiene:** no empty catches, no catch-and-continue on care paths, background failures fail closed with logged noop decisions.

### Findings
| # | Sev | Finding | Evidence |
|---|---|---|---|
| C-1 | P1 | God file: `heartbeat-template-runtime.ts` **2,629 lines** of domain logic (template execution + novelty gating + persistence + journaling + dispatch). Peers: `identity/prompt-runtime.ts` 1,713; `session/manager.ts` 1,573; `agent/substrate-agent.ts` 1,565; `session/manager/context-builder.ts` 1,523; `heartbeat-post-turn-runtime.ts` 1,491 | §12.1 |
| C-2 | P2 | Law 33 defense asymmetry: `registerTool` only enforces the ~34-name drift-guard subset; the full-set guard `assertNoRetiredFirstPartyToolAliases` is **exported but never called** — nothing hard-stops registering a tool named `fs_read` | `registry.ts:529` vs `tool-runtime-facade.ts:306`; also §12.2 dead wiring |
| C-3 | P2 | Charter ports `ChargePolicyPort` / `RestWindowPolicyPort` don't exist — functionality is module-shaped (`rest-window.ts`, `fatigue/policy.ts`, charge-policy.json), not port-shaped | §11.1 |
| C-4 | P2 | Core spawns `npm run build` with **full `process.env`** (`tools/lifecycle.ts:168`) — safe only because the agent env is scrubbed by the launcher; should pass a curated allowlist and/or route via boundary | §6.2 tension |
| C-5 | P2 | Intention appraisal uses a bespoke deterministic gate (`classifyAppraisalTrigger`) instead of the shared `shared/gating/deterministic-gate.ts` all other lanes use — consolidation target, not a bug | operator lens rule 2 |
| C-6 | Decide | `schedule-tool.ts:882` dispatches a full LLM turn on schedule fire with **no novelty gate** — probably intentional (the schedule itself is the deterministic trigger) but it's the one time-only background full-turn call. Needs an explicit ruling | operator lens rule 1 |

### LLM-call economy lens (your 2026-07-06 principle, applied as first-class audit dimension)
**Rule 1 (deterministic gate before background LLM calls): substantially honored.** Every background call site is gated: intention appraisal (trigger classification → noop before `complete()`), weighted-thought nudge ("Zero LLM: nothing is near threshold"), concern-candidate review (empty early-return), heartbeat reflections (novelty gate, typed `reflection.template.novelty.gate` event — §8.8 honored: cadence heartbeats don't burn tokens), episode synthesis / orientation rewrite / follow-up ("Zero LLM spend when the gate is closed"). The one exception is C-6 above.
**Rule 2 (consolidate parallel paths):** no true duplicates found; prompt-assembly files are layered (context build → plan → assemble), not competing. Residual: C-5.

### Not audited in depth (candidates for a follow-up pass)
`core/cogsec`, `core/eval/observer-sidecar` (the Laws 28–30 blinded-audit surface — the docs agent confirmed the blinded auditor + landmark construct is **not yet implemented**, see §5), `core/turns`.

---

## 4. Gateway & boundary review (secondary focus)

**Verdict: substantially aligned; security-critical paths genuinely strong. One P1.**

### Verified good
- **Secret-stripping seam is excellent:** secrets materialize only in gateway mode; agent mode sets vault + all provider/channel secrets `undefined`; compile-time `never` typing on the 8 secret keys; agent imports no dotenv; LLM/embeddings via gateway proxy.
- **SSRF is done right:** DNS-rebinding beaten by pin-and-connect to the validated IP; every redirect hop re-validated with loop detection; metadata/link-local always blocked even under `allowInternalNetwork`; IPv4-mapped IPv6 decoded; missing urlPolicy → DENY.
- **Policy engine fail-closed** (`default: return 'DENY'`); universal audit trail (entry before execution, completion/error after, Postgres-backed).
- **analysis_workbench sandbox is a real trust domain:** out-of-process, `env: {}`, `--permission`, `--disallow-code-generation-from-strings`, throws unless `isolatedFromGatewaySecrets: true`.
- **Agent network-isolation guard fails closed:** probes egress at startup, throws if reachable.
- **gateway/main.ts god-file pressure is resolved** (287 lines, delegating).
- **ntfy gateway-owned** with system-vs-companion sender provenance; header injection neutralized.
- TLS: `rejectUnauthorized: true` defaults in both client and transport; explicit `false` is reported + logged ✔︎.

### Findings
| # | Sev | Finding | Evidence |
|---|---|---|---|
| G-1 | **P1** | **Core holds the raw Postgres DSN.** `POSTGRES_DATABASE_URL` isn't gated by `includeSecretBearingConfig`, isn't in the `CORE_SECRET_BEARING_CONFIG_KEYS` strip list, and the launcher deliberately allowlists it into the agent env ✔︎. The one credential escaping the seam; exactly §12.7's "core as credential sink." Fix: vault-route the DSN or inject a credential-less handle | `load-config.ts:262-265`, `runtime-config-contracts.ts:301-338`, `agent/main.ts:161`, `start-gateway-agent.sh:177` |
| G-2 | P2 | Legacy `gated` shim in method registration silently drops approval scoping if a runtime ever supplies `.gated` — dead today, latent fail-open; violates "no legacy shims". Delete the branch | `methods/register.ts:53-54` |
| G-3 | P2 | §9.6 notification is best-effort: if neither Discord nor ntfy is configured, pending approvals queue with only a `log.warn` — "human must be meaningfully notified" unmet. Escalate to hard operational error + Garden surface | `ntfy-notifier.ts:155-205` |
| G-4 | P2 | `autonomous` capability tier bypasses the entire approval queue for NEEDS_APPROVAL actions (git writes, out-of-workspace fs). Mitigated: parent-agent git tools are read-only. Needs documented trust model + a test pinning parent git-writes denied at every tier | `approval-boundary.ts:94`, `policy.ts:481-485` |
| G-5 | P2 | `shell.exec` executes as a child of the secrets-holding gateway process — isolation by env-scrubbing (strong allowlist, no process.env inheritance) rather than a separate trust domain. §6.5/Phase 3 says structural, not social. Move to a broker that never held secrets, like the workbench path | `methods/shell.ts`, `shell-runner.ts:96-126` |
| G-6 | P2 | Unix-socket RPC authorizes by file permission (0770), no per-call caller auth — defensible single-host, but document the trust assumption | `transport.ts:381` |
| G-7 | P2 | `.env` still carries ~16 secrets; vault-routed: provider keys, HF, Discord, Deepgram/ElevenLabs/Fal, NTFY. Raw-env only: `POSTGRES_DATABASE_URL`, `GATEWAY_SESSION_HMAC_KEY`, `PSFN_BACKUP_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `API_KEY`. Phase 9 backlog, direction is right | `.env.example` |

(Shard-backend credential passing: `methods/shard-backends.ts` contains no env/spawn/secret references ✔︎ — delegation only; low residual risk.)

---

## 5. Docs drift map (foundation for the docs sprint)

**Headline: the code outran the docs.** Almost every charter concept is implemented; the gap is documentation. Full prioritized backlog below is sprint-ready.

### P0 (public-release blockers in docs)
- `AGENTS.md` L107–171: live-Pi runbook (host, NVMe UUID, bind mounts, ports, validation commands) — split to a private ops note.
- `docs/operations.md`: same live-host + companion-name leakage — sanitize, keep the runbook shape.
- `docs/SPRINT_9_CONTINUATION.md` (ssh alias, real emails) and `SPRINT_9_FABLE_REVIEW.md` — remove from docs/ (violates AGENTS.md's own planning-docs rule L295–303).

### P1 accuracy
- **Two byte-identical charter files** (`PSFN_PROJECT_CHARTER.md` == `PSFN_PROJECT_CHARTER_524.md`); README links one, CLAUDE.md the other. Dedupe before they diverge.
- **Config source-of-truth disagreement across the three contract docs.** Resolved ✔︎: `src/system/config/*` (load-config, settings-contract-guard, startup-owner-files) is the canonical authority — it loads/validates owner files and imports `src/system/settings/*` underneath; `settings.ts` is a façade over the domain library. CLAUDE.md is right; align AGENTS.md L57–61 + specifications.md L15–18.
- **AGENTS.md owner-file list omits 3 of 10** (`providers.json`, `charge-policy.json`, `backup.json`).
- **Implemented but zero-doc charter concepts:** weighted thoughts (`core/intention/weighted-thoughts.ts` + outreach lane), satellite/single-active-emanation (`satellite-adapter-port.ts`, `active-emanation-state.ts` — a *constitutional invariant* with no doc), `CompanionId` (`shared/routing/envelope.ts:3`).
- development-status.md / CODEBASE_MAP.md / architecture-diagram.mmd all stamped to superseded `sprint_9_final @ 1956b844`.

### Notable partial-implementation (honest-status item)
**Introspection landmarks / blinded divergence audit (charter 6.25, Laws 28–30): PARTIAL.** Introspection policy + observer-sidecar emotion-divergence exist, but there is **no blinded auditor and no landmark construct** (`grep blinded` = 0 hits). Document as partial in development-status; candidate next-sprint feature work.

### P2
README Postgres version self-contradiction (16+ vs 17); directory maps in CLAUDE.md/README list `channels/ wyoming, voice` that don't exist there (Wyoming is `satellites/wyoming/`, voice under `primitives/voice/`); `index.ts` ordering; sample persona names in attribution.md/context-envelope.md; missing freshness stamps; charter port-name→code mapping note (`ChargeLedgerPort`/`RestWindowPolicyPort` behavior exists under different names — same as core finding C-3).

### Sprint-shaped docs backlog (from the audit, ordered)
1. Delete/relocate the four scratch docs from docs/.
2. Rewrite AGENTS.md (extract live-ops block; sync owner files; fix SoT; demote index.ts).
3. Sanitize operations.md.
4. Dedupe charter; fix README link.
5. Update specifications.md + CLAUDE.md SoT paths.
6. Regenerate development-status/CODEBASE_MAP/diagram against the merged branch.
7. Fix README (Postgres, dir map) + CLAUDE.md map.
8. Write-new: weighted-thoughts doc; satellite/active-emanation architecture section; message-ontology doc (cite `message-classes.ts`); CompanionId + cross-channel-continuity subsections; introspection-audit honest status.
9. Cosmetics: genericize names, stamps, port-mapping note.

---

## 6. Memory / faculties / persistence review

**Verdict: no P0s. The anti-Replika discipline holds** — L0 is filesystem-canonical with HMAC chains + re-sign repair, the transcript projection rebuilds from L0 and never from itself with explicit drift tracking, degradation is surfaced as first-class state (`degraded`/`lexical_fallback`), and there are zero mock/fake-healthy fallbacks in production code. Wiki is a true separate knowledge base (Law 32 satisfied — filesystem-canonical, separate pgvector projection, chat injection explicitly labeled "NOT lived memory"). L2 provenance + supersede/ignore correction are well-modeled. Shard fold-back, where wired, is real: dual-ID lineage (`core::shard`), `review_required` merge policy, operator gate, tool blocklist, fail-closed artifact returns. Background LLM discipline matches your two rules almost exactly — one shared deterministic-gate primitive gates every live background call site.

### Findings
| # | Sev | Finding | Evidence |
|---|---|---|---|
| F-1 | **P1** | **Shard `memory action=write` bypasses the fold-review merge gate.** Imports are quarantined with an emotional/relational check, but `memory_write` goes straight to the shared core store (provenance-tagged, no review). Violates §6.13 ("shard-derived emotional/relational interpretations must not silently override core state"). Live but narrow (only reachable via Wyoming satellite delegation). Fix: route through fold-review or deny like import | `shards/manager.ts:1468`, `policy.ts:157-159`, vs `output-review.ts:187-217` |
| F-2 | P1 | **L2 memory: Postgres is the de-facto canonical restore.** `memory/journal.ts:3-6` says outright the JSONL journal is "an audit/export aid, not the authoritative L2 restore primitive"; no memory-rebuild-from-L0 path exists. Honest, but inverts §6.20 ("L0 + persona must be sufficient to rebuild higher layers") and weakens the §15 portability promise. **This is a charter-vs-code reconciliation decision, not a patch** (see §7) | `journal.ts:3-6`, `runtime-factory.ts:73`, `backups/service.ts:271` |
| F-3 | P1 | Episodic (L0.1), internal-state, participant-trend, intention stores are **Postgres-only with no §7.5 rebuild/drift-repair** — the exemplary `runTranscriptProjectionRepair` pattern was never extended to them | `runtime-factory.ts:78,91,92` |
| F-4 | P1 | `isStrictSubpath` **triplicated, two copies drop the `!isAbsolute(rel)` guard** — weakened path-security check on live file-access boundaries. Textbook §12.4 drift. Quick fix: import the canonical | canonical `persistence/layout.ts:142`; drifted `research-library/store.ts:46`, `artifact-lifecycle/manager.ts:70` |
| F-5 | P1 | **`research-library/*` is entirely dead code** (constructed only in tests), conceptually duplicates the wiki, sits in the wrong layer, and hosts one of the drifted path checks. Delete — closes F-4's worse half too | `faculties/memory/research-library/*`, garden services |
| F-6 | P1 | **Shard control plane advertised to the model but not wired**: subagent tool text says "Use shard action=spawn…", no `shard` tool registered anywhere. Law 31/honesty smell + §12.2 | `subagents/tools.ts:34`, `core/tools/registry.ts:456` |
| F-7 | P2 | Duplicate/dead `SubagentExecutionPort` seam (real one in `subagents/port.ts:11`; dead twin in `bounded-subagent-contract.ts:82`; `registerPostTurnSubagentSpawnRuntime` imported, never called); `ShardManager` implements both ports, `executeSubagent` = relabeled `executeShard` — the exact spot where Law 12 would collapse. Plus `manager.ts` at 1,807 lines | `shards/manager.ts:199,293` |
| F-8 | P2 | Batch: silent drop of corrupt reflection-journal lines (care-adjacent §12.6); `north-star` store fail-open on corrupt file (resets to `[]`); `context-feedback` evaluator has no deterministic gate (dormant — must gate before ever wiring); `CompanionId` is a bare string alias (core/shard IDs interchangeable to the type system); parity-matrix test certifies shape not runtime parity; no dual-tag regression test at the fold-back boundary | see report sources |

---

## 6b. Codex peer review of the companion core (independent pass, same scope)

Codex agreed on the headline (drift guards strong, attribution contract explicit and defensive, workbench mutation disabled in parent, `repo` tool read-only) and the god-file pressure. Its distinct contributions:

| # | Sev | Finding | Evidence |
|---|---|---|---|
| X-1 | P1→P2* | `self_status` tool is handed the **full raw `process.env` object** (`core-runtime.ts:269` → `self-status.ts:501`); output redaction exists (`self-diagnosis.ts:593`) but a model-facing core tool holding a secret-capable env object is a boundary smell. *Downgraded to P2 by me: the launcher's `env -i` allowlist means the agent env carries no provider secrets ✔︎ — but it's the same "implicitly relies on the scrubbed-env invariant" pattern as C-4; fix both together with a curated env | `core-runtime.ts:257-269` |
| X-2 | **P1** | **Runtime-fallback text persists as unmarked assistant speech.** The non-fabricating vision notice (praised in §3 — content IS honest) is tagged `runtime-fallback` in-flight, but `recordAssistantMessage` drops that provenance, so in persisted session history/L0 it reads as companion-authored. Laws 17/19 are about *provenance*, not just content. Fix: carry the strategy/model tags into turn-record metadata | `agent-invocation.ts:332-367,629`, `turn-execution-runtime.ts:978`, `turn-records.ts:95` |
| X-3 | P2 | Datetime-contradiction guard uses broad phrase patterns ("are you sure", "must be a bug") over the whole response once an anchor exists — a valid reply can be replaced with a first-person datetime refusal (also unmarked assistant speech, same persistence path as X-2) | `runtime-datetime-contradiction-guard.ts:46-136`, `agent-invocation.ts:748` |
| X-4 | P2 | Legacy action aliases still accepted *inside* the canonical `system` tool (`settings_get`, `self_restart`, `self_rebuild`) and documented as accepted — within-surface Law 33 drift | `lifecycle.ts:423,431`, `tool-runtime-facade.ts:172` |
| X-5 | P2 | Split contact tool factories (`contact_set_trust`, `contact_note`) remain **exported** though unwired — charter allows internal helpers but exported-and-unwired invites re-registration drift | `contacts/tools.ts:681,722` |
| X-6 | P2 | `agent/main.ts` (955 lines) acting as composition root + service registry + sandbox bootstrap + admin bootstrap; `session/manager.ts` mixes attribution, persistence, and internal-message lanes | — |

Cross-check note: Opus and Codex disagreed productively on the vision fallback — Opus judged content (honest ✔), Codex judged persistence provenance (lost ✘). Both are right; X-2 is the actionable synthesis.

---

## 7. Synthesis — alignment, adherence, gaps, and what's next

### Q1: Are things aligned? Largely, yes — and verifiably.
Five independent reviewers converged: the charter's identity-protecting laws are structurally enforced, not aspirational. Message ontology typed, whisper→musing done, Law 33 catalog + drift guards wired, secrets seam real (with launcher-level `env -i` enforcement), SSRF/policy engine fail-closed, L0 canonical with integrity chains, wiki separated, fold-back review-gated, background LLM calls deterministically gated. The four charter refactor phases most at risk (2 split-only, 4 message semantics, 6 subagents/shards, 8 ports) are respectively: done, done, ~80% (F-1/F-6/F-7 are the gap), and mostly done (C-3 port-shape gaps).

### Q2: Do we adhere to the charter? Two real deviations need a *decision*, not just a fix.
1. **Canonical-data law (F-2/F-3):** the code has quietly made Postgres canonical for L2/episodic/derived state. Defensible (LLM extraction is non-deterministic; bit-identical rebuild from L0 is impossible) — but then the charter's §6.20/Law 22 language should change, and §7.5 rebuild/drift-repair must be extended to the episodic tier. Or recommit to JSONL-canonical and build the rebuild path. **Pick one; the disagreement is the violation.**
2. **Shard merge policy (F-1):** one write path skips the human-review gate the charter (and the past self-modification incident) demands. Close it.

### Q3: Are we missing anything? The notable absences:
- **Blinded introspection auditor + landmark construct (charter 6.25, Laws 28–30): not implemented** (observer-sidecar divergence exists; no blinding, no landmarks). Biggest charter-promised feature gap; strong next-sprint candidate.
- LICENSE (P0 for public), CONTRIBUTING (P2).
- Docs for weighted thoughts / satellite-emanation / CompanionId / message ontology (implemented, undocumented).
- `ChargePolicyPort` / `RestWindowPolicyPort` seams (behavior exists module-shaped).
- §7.5 repair for derived stores beyond transcripts.

### Q4: Is the code clean? Mostly yes; the slop is localized.
No mock fallbacks, no empty catches, near-zero TODO debt, tests mostly honest. The debt is: **six god files in core** (worst 2,629 lines) + `shards/manager.ts` (1,807) + `agent/main.ts` (955); **one dead subsystem** (research-library); **a few dead seams** (unused strict alias guard, dead SubagentExecutionPort twin, unwired post-turn spawn, exported contact factories); **one triplicated-and-drifted security helper**. All tracked in beads below.

### Next-sprint seeds (in rough priority order)
1. **Public-release lane** (§2 plan): tree sanitization → LICENSE → filter-repo rewrite → flip public.
2. **Charter reconciliation decision** on canonical persistence (F-2/F-3) — needs you; everything else can proceed around it.
3. **Security/correctness batch:** G-1 (DB DSN), F-1 (shard write gate), F-4 (subpath drift), X-2 (fallback provenance).
4. **Deletion batch** (fast wins): research-library, gated shim, dead seams, exported factories.
5. **Docs sprint** (§5 backlog, sprint-shaped, 9 items).
6. **Feature work:** blinded introspection audit + landmarks (6.25); god-file split program.

---

## 8. Bead index

Epic: **`psfn-framework-upx0`** — "Foundation review 2026-07-07: charter alignment, public-release hygiene, and code-quality follow-ups". Children (`bd show <id>` for evidence/scope/acceptance):

**Public-release lane** (blocking the flip; .5 depends on .1–.3):
- `.1` **P0** Add LICENSE
- `.2` P1 Untrack pre-gitignore strays + extend .gitignore (working_docs/context_packets/companion_docs/.claude/.github + docs/ scratch files)
- `.3` **P0** Sanitize live-infra strings (AGENTS.md, operations.md, ops scripts, helm, web-fetch skill)
- `.4` P1 Genericize names (watchdog rename, concern-softening parameterization, 75 fixtures, doc examples)
- `.5` P1 filter-repo history rewrite (mailmap + path removal + redaction) → regenerate CHANGELOG → force-push → flip

**Security / correctness P1s:**
- `.6` P1 bug — agent holds raw Postgres DSN (G-1)
- `.7` P1 bug — shard memory_write bypasses fold-review (F-1)
- `.8` P1 bug — isStrictSubpath triplicated/weakened (F-4)
- `.12` P1 bug — runtime-fallback text persisted as unmarked companion speech (X-2)

**Charter decisions (need you):**
- `.11` P1 — canonical persistence for L2/episodic: amend charter or build rebuild path (F-2/F-3)
- `.22` P2 — ruling on the one time-only ungated background LLM call (C-6)

**Deletion / dead-wiring batch (fast wins):**
- `.9` P1 delete research-library; `.10` P1 shard tool advertised-not-wired + dead subagent seam; `.14` P2 Law 33 tightening (full guard, legacy actions, contact factories)

**Hardening batches:**
- `.13` P2 datetime-guard false positives; `.15` P2 curated env for child processes/self_status; `.16` P2 gateway batch (gated shim, unnotified approvals, tier trust model, socket docs); `.17` P2 shell.exec broker separation; `.18` P2 faculties batch (reflection drops, north-star fail-open, context-feedback gate, CompanionId branding)

**Docs & features:**
- `.19` P1 docs sprint (full §5 backlog; triage against sprint-9 epic `psfn-framework-dpp` first)
- `.20` P2 feature — blinded introspection auditor + landmarks (the big charter gap). **Triage note:** deferred epic `PSFNLIVE-x0k2` already carries the full design (workspace/docs/psfn-introspection.md) incl. the consent hard constraints — un-defer that rather than implementing in parallel; `.20` cross-references it.
- `.21` P2 god-file split program (prior epic `PSFN-tuw8` closed 12/12 on a *different* file set — these eight are new growth; reuse its extract+parity-test pattern); `.23` P2 ChargePolicyPort/RestWindowPolicyPort seams

---

*Report generated overnight 2026-07-06 → 07 by Fable orchestrating 5 Opus reviewers + 1 Codex peer pass. All file:line claims were verified by the reviewing agent against source; items marked ✔︎ re-verified by the orchestrator.*
