# Agent Instructions

## Purpose

This file is the repo-specific operating contract for AI coding agents working in this repository.

Use it together with the current code, not instead of it. When workflow text here conflicts with the live runtime or config contracts, the code wins.

## Issue Tracking

This repo uses `bd` for all tracked work.

Required session start for tracked work:

```bash
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
3. Product/runtime overview and deeper design docs
   - `README.md`
   - `docs/specifications.md`
   - `docs/architecture.md`
   - `docs/memory.md`
   - `docs/operations.md`
   - `docs/setup.md`
4. Bootstrap examples only
   - `.env.example`

Do not assume `.env.example` is the current authority for mutable settings.

## Configuration Rules

Configuration uses strict ownership.

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

## Live Deployment Boundary

For the live running app in this repo, everything operationally authoritative must live under this repo tree.

Rules:

- Do not create, edit, or rely on live runtime/service/env config outside this repo tree without explicit user permission.
- Forbidden without explicit permission: `~/.config/systemd/user/*`, home-directory env files, ad hoc supervisor drop-ins, and any other off-repo runtime overrides.
- Do not create shadow copies of live unit files, env files, or runtime wiring in `$HOME`, `/tmp`, or other side locations just to avoid a restart or make a workaround stick.
- If the live service must change, change the repo-owned file in this directory and restart the service if needed. A required restart is acceptable; hidden off-repo config is not.
- If the supervisor requires a registration artifact outside the repo, it must only be a thin pointer to a repo-owned file, never the authoritative config itself, unless the user explicitly approves otherwise.

## Runtime Entry Points

Use the right entrypoint for the task:

```bash
npm run dev                 # split gateway + agent launcher
npm run gateway             # host-side gateway
npm run agent               # isolated agent entrypoint
npm run split               # same launcher as npm run dev
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

- `npm run lint`
- `npm run build`
- targeted `npm test -- --run ...`
- `npm run verify:settings-contract` for settings/config changes
- `npm run verify:repository-hygiene` for repo-surface changes
- smoke or reachability verification for new runtime wiring

`npm run lint` is mandatory for every tracked code change before closing or pushing work. If lint cannot run, stop and surface the blocker instead of silently skipping it.
No worker or sub-agent may mark a bead done, ask for closure, or close a bead until `npm run lint` has passed in that worktree for the change it made.

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

## Parallel Execution

Use parallel streams only when the dependency graph supports it. Prefer up to three concurrent streams for multi-bead efforts; fewer is better when the ready queue is narrow or the merge surface is tightly coupled.

### Integration branch policy

- For a large multi-bead initiative, create a dedicated integration branch and keep parallel work scoped to that branch until the effort is validated.
- Create each worktree from the integration branch and merge each completed stream back into the integration branch, not directly into the protected release branch.
- Keep the release branch stable while the parallel effort is in flight. Merge the integration branch into the release branch only after the user or operator finishes the required manual verification.

### Standard parallel loop

1. Select the next highest-priority ready beads that are safe to run in parallel.
2. Create one worktree per selected bead or stream.
3. Spawn at most one sub-agent per worktree and give it explicit ownership of its bead, files, and validation scope.
4. Require each sub-agent to implement only its assigned bead, run targeted validation, run `npm run lint`, and commit its work inside its own worktree.
5. Let the streams run without constant check-ins. Do not micro-manage active workers; check on them only when they report a blocker, finish, or have been silent for an unusually long interval such as 20 minutes.
6. When the selected streams are complete, merge them back into the integration branch and resolve conflicts only at the orchestrator level.
7. Run validation on the integration branch for every merged area, plus broader regression coverage when the combined change surface warrants it.
8. Update bead state after integration: close completed beads with evidence, and reopen or create follow-up beads when new work is discovered.
9. Repeat with the next set of ready beads until the non-deferred work for the initiative is complete.

### Merge and validation policy

- Merge blocker-unlocking or dependency-clearing beads first when merge order matters.
- If two streams conflict, resolve the conflict once on the integration branch and rerun the impacted tests there.
- Do not close a bead without validation evidence for the area it changed.
- Do not close a bead unless `npm run lint` passed for the worker or worktree that produced the change.
- Keep the bead tracker aligned with the integrated branch state, not with partial work still isolated in side worktrees.

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
   `npm run lint` is a mandatory gate for every tracked code change.
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
- Do not close a worker bead before its worktree has a passing `npm run lint` result.
