# Agent Instructions

## Purpose

This file is the repo-specific operating contract for AI coding agents working in this repository.

Use it together with the current code, not instead of it. When workflow text here conflicts with the live runtime or config contracts, the code wins.

## Issue Tracking

This repo uses `bd` for all tracked work.

Required session start for tracked work:

```bash
bd onboard
bd prime
```

Then use `bd` for discovery, claiming, follow-up issues, and closure.

### Standard flow

```bash
bd ready --json
bd show <id> --json
bd update <id> --claim --json
bd create "Title" --description "Self-contained task details" -t task -p 2 --json
bd close <id> --reason "Completed" --json
# if a Dolt remote is configured for beads
bd dolt push --json
```

Rules:

- Use `--json` for programmatic use.
- Do not rely on `bd sync`; the installed CLI here uses `bd dolt push` and `bd dolt pull` instead.
- Do not create markdown TODO lists or external task trackers.
- If `bd ready --json` is empty but you are doing user-requested tracked work, create a self-contained issue before editing code.
- Link discovered follow-up work with `discovered-from:<parent-id>`.
- Keep issue descriptions self-contained: summary, files, concrete steps, and an example when useful.

## Current Phase V Reality

This `phase-v` branch already contains major implemented Phase V work. Do not treat it like a pure planning branch.

Implemented foundations on this branch include:

- registry-driven plugin seams for channels, STT, and TTS
- schema-owned settings and owner-file enforcement
- two-root persistence topology (`system-data` and `companion-data`)
- compositional extraction, retrieval, appraisal, nested think, shard context packs, and diagnostics
- observation masking, context manifests, stable-prefix context optimization, and context feedback scoring
- emotion state, active concerns, self-model snapshots, and metacognitive flags
- background continuation slices and shard lifecycle hardening
- Telegram, Wyoming, Garden, backup/restore verification, and beads gateway tools

Use [PHASE_V.md](./PHASE_V.md) as the branch status ledger.

## Source Of Truth

Prefer these files when checking behavior:

1. Runtime entrypoints and wiring
   - `src/index.ts`
   - `src/runtime.ts`
   - `src/gateway-main.ts`
   - `src/agent-main.ts`
2. Config and ownership contracts
   - `src/types.ts`
   - `src/settings.ts`
   - `src/config/settings-contract.ts`
   - `src/persistence/layout.ts`
3. Phase-V status and sequencing
   - `PHASE_V.md`
4. Bootstrap examples only
   - `.env.example`

Do not assume `.env.example` is the current authority for mutable settings.

## Configuration Rules

Phase V enforces strict ownership.

Use `.env` only for:

- secrets
- host/port/socket wiring
- runtime mode/layout wiring
- optional bootstrap overrides that are explicitly env-owned

Mutable runtime settings belong in canonical JSON owner files in the system-owned config domain:

- `settings.json`
- `models.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`

Companion state belongs under `companion-data`.

Guardrails:

- If only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set, startup must fail.
- Production layout roots must not overlap.
- New settings must be wired through the owner-file contract, Garden exposure, and tests.
- Run `npm run verify:settings-contract` when touching settings or settings UI.

## Runtime Entry Points

Use the right entrypoint for the task:

```bash
npm run dev                 # single-process runtime
npm run gateway             # host-side gateway
npm run agent               # isolated agent entrypoint
npm run split               # gateway + agent launcher
npm run yolo                # split runtime with broader fs.read policy
npm run agent:docker        # production containerized agent
npm run agent:docker:continuous
```

Additional useful commands:

```bash
npm run build
npm test
npm run lint
npm run verify:repository-hygiene
npm run verify:backup-restore
npm run smoke:chat
npm run e2e
npm run e2e:voice
```

## Coding Standards

1. Security: fail closed.
2. Error handling: no swallowing.
3. No legacy code paths or compatibility shims.
4. No silent fallbacks for required config or security-sensitive dependencies.

Expanded meaning in this repo:

- Unknown plugin/provider/owner data should reject, not silently coerce.
- JSON-owned config must not quietly drift back to env authority.
- Gateway policy and path checks must deny by default.
- If a capability or confirmation requirement is missing, stop the action.

## Supply Chain Pinning

- Do not use floating dependency or image references such as `latest`, `main-latest`, branch names, or unpinned aliases.
- When adding or updating external packages, container images, or fetched artifacts, pin them to an exact version. Prefer immutable digests for container images when operationally practical.
- Do not widen version ranges as part of routine maintenance. If you touch a dependency for security or upgrade work, land it as an exact pin in the repo.
- Treat floating upstream refs as a supply-chain risk. Replace them instead of preserving them.

## Structure Requirements

- Do not create or expand god files.
- Prefer focused modules with clear ownership boundaries.
- Extend existing primitives before inventing new parallel abstractions.
- If a file is getting large, split by domain capability before adding more.
- Verify new runtime code is wired to a real entrypoint or registry path.
- Before closing work, confirm there are no unreachable production modules or unwired settings.

## Validation Expectations

If your change touches code, run the smallest set of quality gates that proves it.

Common expectations:

- `npm run build`
- targeted `npm test -- --run ...`
- `npm run verify:settings-contract` for settings/config changes
- `npm run verify:repository-hygiene` for repo-surface changes
- smoke or reachability verification for new runtime wiring

Include the result in your handoff.

## Planning Documents

Put AI-generated planning or audit docs in `history/`, not the repo root.

Examples:

- `history/PLAN.md`
- `history/ARCHITECTURE.md`
- `history/TESTING_GUIDE.md`

Do not add ad hoc planning files at the top level unless the user explicitly asks for that.

## Parallel Work Safety

Never delete or destroy shared git state without explicit user confirmation.

Forbidden without approval:

- `git branch -D` or `git branch -d`
- `git worktree remove`
- `git stash drop` or `git stash clear`
- `git reset --hard`
- `git checkout -- .`
- `git clean -f`
- deleting directories that may contain worktrees or active agent state

If you notice unexpected local changes that you did not create, stop and ask how to proceed.

## Orchestration Hygiene

If you spawn subagents or parallel workers:

1. Wait for them to finish or interrupt them intentionally.
2. Record each worker's final state before shutdown.
3. Call `close_agent` on every spawned handle.
4. Verify no intentionally active workers remain before ending the session.

A worker saying "done" is not enough. Handle cleanup is required.

## Landing The Plane

A work session is not complete until the changes are committed and pushed.

Required sequence:

1. File issues for remaining follow-up work.
2. Run quality gates appropriate to the change.
3. Update bead status.
4. Push git state:
   ```bash
   git pull --rebase
   git push
   git status
   ```
5. If this repo has a beads Dolt remote configured, push that state too:
   ```bash
   bd dolt push --json
   ```
6. Verify the branch is up to date with origin.
7. Clean up orchestration handles.
8. Hand off with tests run, remaining risks, and any open beads.

Rules:

- Never stop at "ready to push". Push.
- If push fails, resolve it and retry.
- Keep bead state aligned with the shipped git state.
