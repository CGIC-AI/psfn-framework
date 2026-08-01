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

Before a multi-PR wave fans out, run the clean-main baseline command
`npm run gate:canary` from a clean checkout exactly at `origin/main`; a failure
stops the wave. Then run `npm run prewarm` once for the wave (and after lockfile
changes), create the pushed wave branch from the baseline-attested base and each
lane from that wave branch, and run
`npm ci --offline --ignore-scripts` plus `npm run hooks:install` in each.
Never share `node_modules` or `dist` between worktrees.

Lane PREFLIGHT phases may run concurrently. Their full-test HEAVY phases queue
automatically on the machine-wide lock; read its 15-second holder diagnostics
and never remove a lock held by a live PID. Commit and push ordinary non-main
checkpoints immediately; the pre-push hook protects branch history but does not
run the broad gate. Before publication, run `npm run gate:pre-pr` on the exact
head. Passed stages are reused only for the same head, base, gate version, and
command. Rebase rather than merge after any base change, then rerun the gate.

Use ordinary `git push -u origin HEAD` for remote checkpoint durability. Do not
publish with raw `gh pr create` or `gh pr edit`. Assemble compatible small beads
into one coherent review unit and publish its attested exact head with:

```bash
npm run pr:publish -- --title "<title>" --body-file <path>
```

Repeat `--label <name>` for labels that must be visible to the first CI run
(e.g. `change-budget:exception`).

For an existing PR with no metadata change, run `npm run pr:publish`. The wrapper
makes a draft ready before pushing (and creates new PRs non-draft), then rejects
SHA drift or skipped CI/Greptile checks. It requires the authenticated `gh` user
to match the repo's `LOCAL_GATE_STATUS_ACTOR` variable (the status issuer). Keep the owning lane assigned while it
waits. On failure, return the evidence to that lane once; never close/reopen the
PR, rerun GitHub Actions, re-request Greptile, or dispatch a fresh review loop.
The full canary, prewarm, lock, stage-attestation, change-budget, publication,
and slow-test contracts are in
[`docs/orchestration-process.md`](./docs/orchestration-process.md). Portable
machine setup and reviewer prompts are in
[`docs/internal-review-workflow.md`](./docs/internal-review-workflow.md).

## Orchestration Loop (Claude-side wiring)

AGENTS.md owns the repository-wide boundaries, and [`docs/orchestration-process.md`](./docs/orchestration-process.md) owns the full wave protocol. This section is how Claude executes it.

You (Fable) are the orchestrator: plan, decompose, dispatch, synthesize, and
integrate. Read the code and tests needed to understand intent, verify blockers,
and resolve integration seams. Delegate broad discovery and feature
implementation so the main thread retains the wave-level state. Localized merge
or integration corrections are allowed; new behavior returns to a worker lane.

Role wiring:

- **Primary implementer: Codex — `gpt-5.6-sol`**, effort scaled to bead difficulty (`high` for routine beads, `xhigh` only for genuinely hard work — effort is a large latency multiplier). Dispatch directly via the codex-companion runtime with a brief file in the worktree (`node <codex plugin>/scripts/codex-companion.mjs task ...` from the worktree cwd — NOT via the `/codex:rescue` wrapper, which is fire-and-forget and can't be monitored; see memory `codex-pi-dispatch-wiring` for the full mechanics: per-cwd job registry, read-only git sandbox → bundle import, offline npm ci). Treat as a peer engineer, not a reviewer. One bead/stream per dispatch, worktree-isolated per AGENTS.md, explicit file ownership. Always check `status` from the target worktree cwd before dispatching or re-dispatching.
- **Reviewer A: Opus 4.8 @ high** — Agent tool with `model: opus`. Validation and adversarial review, plus all investigation/search fan-out.
- **Reviewer B: Pi agent — GLM 5.2 @ xhigh** via the pi-companion runtime (`node <pi plugin>/scripts/pi-companion.mjs task --effort xhigh ...` from the worktree; read-only without `--write`, so pre-export the review diff to a file). Independent third harness; dispatch it exactly like Reviewer A, blind to Reviewer A's findings.
- **Tiered review:** UBS scans every bead. P0/P1 uses Opus plus GLM, blind; P2
  and below uses one of them. Every reviewer must be from a different model family
  than the implementer. If Fable authored an integration correction, Opus cannot
  count as its independent reviewer; use Codex or GLM instead.
- **deep-reasoner** (`.claude/agents/deep-reasoner.md`, opus): reasoning-heavy phases — architecture, hard debugging, algorithm design.
- High-stakes decisions: task Opus and Codex on the same problem in parallel, blind to each other's answers; synthesize the best of both. Keep your own context lean.

**SUBAGENT MODEL RULE:** Broad exploration/search fanout runs on `model: opus`
or `model: sonnet`, never inherited Fable. Fable still reads the targeted source
needed for orchestration judgments and blocker verification.

Loop, per bead/stream:

1. Decompose to beads; dispatch Codex in worktrees cut from the pushed wave
   branch. Require each lane to commit and push checkpoints.
2. On completion, run UBS and the tiered cross-family review. Reviewers first
   restate intent and shape, then refute with concrete failure scenarios. Use up
   to three workers only when independent seams exist.
3. Dedupe and independently reproduce every blocker claim against the Blocking
   Risk Standard. A reviewer badge or confidence statement is not severity proof.
4. Return verified blockers to the original implementer. Final review is
   closure-only. A new alleged P0/P1 needs a concrete reproduction plus
   corroboration from another model family; one corroborated late blocker gets
   one last scoped pass. Then park the pushed branch if a blocker remains.
5. Integrate compatible beads into the wave branch, assemble a PR-sized train,
   gate its exact head, and publish through `npm run pr:publish`.
6. Merge and close only after required checks are green. Leftover IMPORTANT
   defects go under the wave's fixes epic; nonblocking observations stay in the
   handoff report and never become mid-wave beads.

UBS installation and usage live in `docs/internal-review-workflow.md`; do not
duplicate or replace its pinned installer with a floating upstream command.
