# CLAUDE.md - PSFN Substrate Framework

This file is the technical orientation note for coding assistants working on PSFN.

**[AGENTS.md](./AGENTS.md) is the operating contract and the main source of truth for process**: issue tracking (`bd`), the delivery loop and adversarial-review policy, validation gates, configuration ownership rules, parallel-work safety, and session completion. When this file and AGENTS.md disagree on process, AGENTS.md wins. This file adds repo orientation and the Claude-specific orchestration wiring.

## What This Repo Is

PSFN is a TypeScript runtime for long-lived AI companions.

The codebase currently supports:

- split gateway/agent runtime with policy enforcement
- persistent session and memory systems
- trust-aware privacy and contact modeling
- self-modification surfaces for prompts, code, modules, skills, values, and vault notes
- voice, chat, admin, and protocol adapters across multiple channels
- registry-driven adapters, schema-owned config, compositional cognition, and internal-state modeling

## Source Of Truth

When checking behavior, prefer this order (canonical list maintained in AGENTS.md):

1. Runtime entrypoints and composition: `src/app/gateway/main.ts`, `src/app/agent/main.ts`, `src/app/operator/main.ts`, `src/app/startup/composition/composition.ts`
2. Config and persistence contracts: `src/system/config/` (runtime-config-contracts, load-config, settings-contract-guard, startup-owner-files), `src/persistence/layout.ts`, `src/persistence/runtime-factory.ts` (Postgres-only runtime persistence)
3. Product/design docs: `README.md`, `docs/specifications.md`, `docs/architecture.md`, `docs/chat-turn-lifecycle.md`, `docs/memory.md`, `docs/operations.md`, `docs/setup.md`
4. `.env.example` is a bootstrap template only — never the authority for mutable runtime settings (those live in the JSON owner files; see AGENTS.md Configuration Rules).

## Runtime Entry Points

Entry point roles (launch commands and validation gates live in AGENTS.md):

- `src/app/startup/index.ts`: disabled fail-closed entrypoint with dotenv
- `src/app/gateway/main.ts`: host-side gateway holding secrets and external egress
- `src/app/agent/main.ts`: isolated agent process, no dotenv import, gateway-backed providers

## Persistence Model

Two-root split topology, fail-closed:

- `system-data`: system-owned config (the JSON owner files) and operator/runtime state
- `companion-data`: character, prompts, sessions, notes, memories, and related companion artifacts

`src/persistence/layout.ts` enforces path rules; production rejects overlapping mutable roots. Runtime stores are Postgres-only (`src/persistence/runtime-factory.ts`).

## Architecture Map

For a detailed, per-module architecture map (module guides, dependency notes, data-flow diagrams, cross-cutting conventions, and a navigation table), see [`docs/CODEBASE_MAP.md`](./docs/CODEBASE_MAP.md) — regenerated 2026-07-08 by the cartographer skill. The summary below is the quick orientation; the map is the deep reference.

Key directories that matter now:

```text
src/
  app/                entrypoints (gateway, agent, operator, startup composition, maintenance, e2e)
  boundary/           gateway RPC/policy/SSRF/audit, sandbox execution, fs/git/web/shell/vault/beads adapters, credential vault
  channels/           api, discord, telegram, wyoming, voice, backplane transports
  core/               SubstrateAgent, prompts/identity, scheduler, session, emotion, self-model, intention, contacts, tools
  faculties/          memory (extraction/retrieval/episodic/sleeptime), skills, subagents, shards, media, core-memory, values, context-feedback
  operator/garden/    Garden server, admin routes, services, audit/telemetry
  persistence/        runtime layout, sessions, JSONL journals, Postgres stores/migrations, backups, repair
  primitives/         LLM provider ports, images, voice transports, request context
  shared/             contracts, event bus, telemetry, routing, logger, utilities
  system/             config owner files, settings contract, capabilities, trust, lifecycle
```

## Architecture Highlights

### Registries and adapters

- channels, STT, and TTS resolve through registries/manifests with fail-closed activation and parity across runtime modes
- key files: `src/channels/`, `src/primitives/voice/`, `src/app/startup/composition/composition.ts`

### Config ownership and Garden exposure

- mutable runtime settings are owned by canonical JSON files, guarded by owner-file validation, and exposed through Garden/admin APIs
- key files: `src/system/config/settings-contract-guard.ts`, `src/system/config/startup-owner-files.ts`, `src/operator/garden/api-routes.ts`, `admin-ui/`

### Cognition and context

- retrieval, extraction, appraisal, analysis workbench context, context manifests, observation masking, and context feedback all feed runtime decision-making
- key files: `src/faculties/memory/extraction/`, `src/faculties/memory/retrieval.ts`, `src/core/intention/`, `src/core/session/` (context manifests, attribution guard), `src/core/tools/analysis-workbench/`, `src/faculties/context-feedback/`

### Affect, self-model, and background work

- emotion state, active concerns, self-model snapshots, metacognitive flags, background continuation, and shard lifecycle management are first-class runtime surfaces
- key files: `src/core/emotion/`, `src/core/intention/`, `src/core/self-model/`, `src/core/agent/post-turn-action-runtime.ts`, `src/core/scheduler/heartbeat-post-turn-runtime.ts`, `src/faculties/shards/manager.ts`
- the disabled-by-default, non-authoritative observer-eval sidecar (`src/core/eval/observer-sidecar/`) shadows live emotion state against the `emo_sim` engine for eval telemetry only — see [`docs/observer-eval-sidecar.md`](./docs/observer-eval-sidecar.md)

### Cognitive security (intake firewall)

- untrusted inbound content (web, documents, images, tool output) is wrapped in taint-tracked intake envelopes, screened through layered scanners/classifiers, and gated at consequential sinks; quarantined items resolve only through the Garden Cognitive Security queue; firewall notices are excluded from emotion appraisal and memory candidacy — see [`docs/cognitive-security.md`](./docs/cognitive-security.md)
- key files: `src/shared/contracts/intake-envelope.ts`, `src/core/cogsec/intake/`, `src/boundary/gateway/intake/`, `src/system/config/intake-policy-config.ts`, `src/core/session/intake-sink-gating.ts`

## Channels And Interfaces

Implemented runtime surfaces:

- Discord text and voice
- Telegram text plus attachments, polling, and webhook modes
- OpenAI-compatible API at `/v1/chat/completions`
- API voice websocket runtime
- Garden admin UI at `/garden` (primary admin surface; routing is `/login`, `/garden`, `/api/admin/*`)
- Wyoming TCP server and service registry

## Tools And Agent Surfaces

Do not rely on hardcoded tool counts in docs. The live set is wired across runtime composition (`src/app/startup/composition/composition.ts`, `src/app/agent/main.ts`, `src/persistence/runtime-factory.ts`).

Tool surface split:

- direct agent tools are registered as `core` or `extended` and participate in activation, promotion, and adaptive-tool telemetry (`src/core/agent/tool-surface/registry.ts`)
- REPL-only helpers exist only inside `analysis_workbench` sandbox execution and are not direct tool-catalog entries
- shared names can appear in both places, so docs and Garden should call out whether a tool is direct, REPL-only, or both

## Current Development Posture

Treat the repo as active implementation, not a planning branch. Determine current work from `bd`, the entrypoints above, and the live code paths rather than roadmap language.

## Working Rules

- Fail closed.
- No swallowed errors.
- No legacy compatibility shims.
- No silent fallback behavior for required config or security-sensitive paths.
- Verify new code is actually wired to a runtime entrypoint or registry path.
- Keep docs, config ownership, and tests aligned in the same change.

Everything else — beads workflow, validation gates, parallel-work rules, session completion ("landing the plane"), live deployment boundary — is in AGENTS.md. Follow it.

## Local delivery wiring

Before a multi-PR wave fans out, run `npm run gate:canary` from a clean checkout
exactly at `origin/main`; a failure stops the wave. Then run `npm run prewarm`
once for the wave (and after lockfile changes), create the feature branch from
the canary-attested base and each lane from that feature branch, and run
`npm ci --offline --ignore-scripts` plus `npm run hooks:install` in each.
Never share `node_modules` or `dist` between worktrees.

Lane PREFLIGHT phases may run concurrently. Their full-test HEAVY phases queue
automatically on the machine-wide lock; read its 15-second holder diagnostics
and never remove a lock held by a live PID. After the one verified-P0/P1
remediation pass, commit each exact head and run `npm run gate:pre-pr`. Passed
stages are reused only for the same head, base, gate version, and command. Rebase
rather than merge after any base change, then rerun the gate.

Do not bypass the tracked pre-push hook or publish with raw `git push`,
`gh pr create`, or `gh pr edit`. Assemble compatible small beads into one
coherent review unit and publish its attested exact head with:

```bash
npm run pr:publish -- --title "<title>" --body-file <path>
```

For an existing PR with no metadata change, run `npm run pr:publish`. The wrapper
makes a draft ready before pushing (and creates new PRs non-draft), then rejects
SHA drift or skipped CI/Greptile checks. Keep the owning lane assigned while it
waits. On failure, return the evidence to that lane once; never close/reopen the
PR, rerun GitHub Actions, re-request Greptile, or dispatch a fresh review loop.
The full canary, prewarm, lock, stage-attestation, change-budget, publication,
and slow-test contracts are in
[`docs/orchestration-process.md`](./docs/orchestration-process.md). Portable
machine setup and reviewer prompts are in
[`docs/internal-review-workflow.md`](./docs/internal-review-workflow.md).

## Orchestration Loop (Claude-side wiring)

AGENTS.md owns the delivery-loop policy, and [`docs/orchestration-process.md`](./docs/orchestration-process.md) is the full wave protocol (branch/worktree shape, lane tables, review format, fix epics, push policy, operational boundaries). This section is how Claude executes it.

You (Fable) are the orchestrator: plan, decompose, dispatch, synthesize, integrate. You do not implement at scale or bulk-read code yourself.

Role wiring:

- **Primary implementer: Codex — `gpt-5.6-sol`**, effort scaled to bead difficulty (`high` for routine beads, `xhigh` only for genuinely hard work — effort is a large latency multiplier). Dispatch directly via the codex-companion runtime with a brief file in the worktree (`node <codex plugin>/scripts/codex-companion.mjs task ...` from the worktree cwd — NOT via the `/codex:rescue` wrapper, which is fire-and-forget and can't be monitored; see memory `codex-pi-dispatch-wiring` for the full mechanics: per-cwd job registry, read-only git sandbox → bundle import, offline npm ci). Treat as a peer engineer, not a reviewer. One bead/stream per dispatch, worktree-isolated per AGENTS.md, explicit file ownership. Always check `status` from the target worktree cwd before dispatching or re-dispatching.
- **Reviewer A: Opus 4.8 @ high** — Agent tool with `model: opus`. Validation and adversarial review, plus all investigation/search fan-out.
- **Reviewer B: Pi agent — GLM 5.2 @ xhigh** via the pi-companion runtime (`node <pi plugin>/scripts/pi-companion.mjs task --effort xhigh ...` from the worktree; read-only without `--write`, so pre-export the review diff to a file). Independent third harness; dispatch it exactly like Reviewer A, blind to Reviewer A's findings.
- **Tiered review (operator decision 2026-07-14):** UBS scan of the change range on every bead as the baseline gate. P0/P1 → both reviewers, blind. P2 and below → one reviewer (alternate A/B), escalating to the second when the review or scan looks suspicious (multiple blockers, messy implementation, unexpected security/welfare/data touches). Blocker verification is unchanged at every tier.
- **deep-reasoner** (`.claude/agents/deep-reasoner.md`, opus): reasoning-heavy phases — architecture, hard debugging, algorithm design.
- High-stakes decisions: task Opus and Codex on the same problem in parallel, blind to each other's answers; synthesize the best of both. Keep your own context lean.

**SUBAGENT MODEL RULE (hard):** Explore/search/investigation subagents run on `model: opus` or `model: sonnet` — NEVER fable. Fable tokens are the most precious resource in this setup; burning them on reading/grepping code is forbidden. Every Agent call that fans out to read code MUST set the model explicitly (default inheritance would silently use fable). Fable is for orchestration and synthesis only.

Loop, per bead/stream:

1. Decompose to beads; dispatch implementation to Codex in a worktree on a `work/<epic>-<bead>` branch cut from the feature branch (branch shape and push policy per `docs/orchestration-process.md`).
2. On completion, run the tiered review gate: UBS scan always; reviewer lanes per the tier above, dispatched independently and adversarially — prompted to refute and produce concrete failure scenarios, not to approve; no reviewer sees another's review or the implementer's self-assessment. Run three worker lanes by default; a hard bead must not idle the other two.
3. Synthesize findings: dedupe, then independently verify every claimed blocker against the Blocking Risk Standard (IMPORTANT ≙ P0/P1) before accepting it — reviewers systematically over-grade severity (confirmed pattern; a blocker claim needs a reproducible failure, not vibes).
4. **One remediation pass** (Codex) scoped to verified blockers only, then one final check. Re-verify the fixed items only — no full re-review, no successive review/remediation cycles. A newly discovered blocker is surfaced to the operator or routed to the fixes epic; it does not authorize another pass.
5. Integrate compatible completed beads into one coherent PR-sized branch, run `npm run gate:pre-pr` on the exact head, and publish once through `npm run pr:publish`. The owning lane receives any CI or Greptile failure and makes no more than the already-authorized remediation commit.
6. Merge and close only after the exact PR head has both required checks green. Leftover IMPORTANT defects → self-contained beads under the wave's `<wave> fixes` epic for a fresh agent; **nonblocking observations go in the handoff report only, never beads**.

````markdown
## UBS Quick Reference for AI Agents

UBS stands for "Ultimate Bug Scanner": **The AI Coding Agent's Secret Weapon: Flagging Likely Bugs for Fixing Early On**

**Install:** `curl -sSL https://raw.githubusercontent.com/Dicklesworthstone/ultimate_bug_scanner/main/install.sh | bash`

**Golden Rule:** `ubs <changed-files>` before every commit. Exit 0 = safe. Exit >0 = fix & re-run.

**Commands:**
```bash
ubs file.ts file2.py                    # Specific files (< 1s) — USE THIS
ubs $(git diff --name-only --cached)    # Staged files — before commit
ubs --only=js,python src/               # Language filter (3-5x faster)
ubs --ci --fail-on-warning .            # CI mode — before PR
ubs --help                              # Full command reference
ubs sessions --entries 1                # Tail the latest install session log
ubs .                                   # Whole project (ignores things like .venv and node_modules automatically)
```

**Output Format:**
```
⚠️  Category (N errors)
    file.ts:42:5 – Issue description
    💡 Suggested fix
Exit code: 1
```
Parse: `file:line:col` → location | 💡 → how to fix | Exit 0/1 → pass/fail

**Fix Workflow:**
1. Read finding → category + fix suggestion
2. Navigate `file:line:col` → view context
3. Verify real issue (not false positive)
4. Fix root cause (not symptom)
5. Re-run `ubs <file>` → exit 0
6. Commit

**Speed Critical:** Scope to changed files. `ubs src/file.ts` (< 1s) vs `ubs .` (30s). Never full scan for small edits.

**Bug Severity:**
- **Critical** (always fix): Null safety, XSS/injection, async/await, memory leaks
- **Important** (production): Type narrowing, division-by-zero, resource leaks
- **Contextual** (judgment): TODO/FIXME, console logs

**Anti-Patterns:**
- ❌ Ignore findings → ✅ Investigate each
- ❌ Full scan per edit → ✅ Scope to file
- ❌ Fix symptom (`if (x) { x.y }`) → ✅ Root cause (`x?.y`)
````
