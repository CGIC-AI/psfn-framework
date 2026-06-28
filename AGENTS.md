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
# local shared Dolt server is authoritative here; commit pending bead changes
bd dolt commit --json
# inspect first; only push if this shows a configured remote
bd dolt remote list --json
# bd dolt push --json
```

Rules:

- Use `--json` for programmatic use.
- Do not rely on `bd sync`; the installed CLI here uses `bd dolt` subcommands instead.
- This repo uses a local shared Dolt server for beads. Verify it with `bd dolt show` or `bd dolt test`.
- A missing Dolt remote named `origin` is not a problem by itself. Do not run or report `bd dolt push` unless `bd dolt remote list --json` shows an actual configured remote.
- `.beads/` is intentionally ignored local runtime/export state. Never `git add .beads`, never force-add `.beads/issues.jsonl`, and do not treat ignored `.beads` changes as code dirt.
- Keep `bd config get export.git-add` at `false`; otherwise `bd` will try to stage ignored `.beads/issues.jsonl` exports and create noisy false warnings.
- Do not create markdown TODO lists or external task trackers.
- If `bd ready --json` is empty but you are doing user-requested tracked work, create a self-contained issue before editing code.
- Link discovered follow-up work with `discovered-from:<parent-id>`.
- Keep issue descriptions self-contained: summary, files, concrete steps, and an example when useful.

## Source Of Truth

Prefer these files when checking behavior:

1. Runtime entrypoints and wiring
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
2. Config and ownership contracts
   - `src/shared/contracts/runtime.ts`
   - `src/system/settings.ts`
   - `src/system/settings/contracts.ts`
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

`WORKSPACE_PATH` is the personal writable files root, not a runtime-state root. For the live Purrsephone deployment, this is repo-root `purrsephone/`. Personal documents, generated/saved images, downloads, personal knowledge-base notes, scratchpad/journal files, authored personal skills, modules, and experiments belong there. Runtime owner files, databases, L0/session state, telemetry, backups, active identity artifacts, and system/default skill config belong in `DATA_DIR` or split system/companion runtime roots.

Guardrails:

- If only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set, startup must fail.
- Production layout roots must not overlap.
- `WORKSPACE_PATH` must not overlap `DATA_DIR`, `SYSTEM_DATA_DIR`, or `COMPANION_DATA_DIR`.
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

## Live Pi Storage Layout

The live Raspberry Pi host is `psfn-shard`. On 2026-06-27, the Crucial NVMe drive was formatted as ext4 and mounted at `/mnt/psfn-nvme` to move PSFN's write-heavy live paths off the microSD card. The root filesystem still boots from the SD card; this is a live-data migration, not a full root-disk migration.

Current NVMe filesystem:

```text
device: /dev/nvme0n1
model: CT500P3SSD8
label: PSFN_NVME
uuid: d1f3c5fc-c352-418f-8fbd-bf72d84935a2
mount: /mnt/psfn-nvme
```

Current Pi boot configuration includes:

```text
/boot/firmware/config.txt: dtparam=pciex1=on
/boot/firmware/cmdline.txt: nvme_core.default_ps_max_latency_us=0 pcie_aspm=off pcie_port_pm=off
```

These live paths are bind-mounted from `/mnt/psfn-nvme`:

```text
/home/psfn/psfn-framework-source
/home/psfn/psfn-satellite-hub
/home/psfn/.cache
/home/psfn/.npm
/var/lib/psfn/runtime
/var/lib/postgresql/17/main
/var/log/postgresql
```

Operational rules:

- Before debugging live storage issues, check `findmnt` first; the path existing is not enough. It must resolve to `/dev/nvme0n1`.
- Do not remove the old SD-backed backups until the operator explicitly approves cleanup. They were preserved with suffix `.sd-pre-nvme-20260627184124`.
- Cleanup is tracked in bead `psfn-framework-wgff`.
- `psfn-satellite-hub.service` and `psfn-companion-ui.service` must be loadable by systemd before `/home/psfn/psfn-framework-source` is bind-mounted. Their current stable registrations are regular files in `/etc/systemd/system`, copied from repo-owned files under `deployment/systemd/`. Treat the repo files as the source, and if they change, update the `/etc/systemd/system` registrations intentionally and record why.
- The old `/etc/systemd/system/*.symlink-pre-nvme-20260627184737` files are preserved only as rollback evidence for the broken early-boot symlink registrations.
- If services fail after reboot, run `systemctl --failed --no-pager`, `systemctl cat psfn-satellite-hub.service psfn-companion-ui.service`, and verify the `multi-user.target.wants` links before changing app code.

Useful validation:

```bash
findmnt -T /home/psfn/psfn-framework-source
findmnt -T /var/lib/psfn/runtime
findmnt -T /var/lib/postgresql/17/main
systemctl is-active postgresql@17-main.service postgresql.service litellm.service psfn.service psfn-satellite-hub.service psfn-companion-ui.service
pg_isready -h 127.0.0.1 -p 5432
ss -ltnp | grep -E ':(5432|4000|10053|10054|5173|8787|8790)'
cd /home/psfn/psfn-framework-source && set -a && . deployment/systemd/psfn.env && set +a && node scripts/chat-cockpit-smoke.mjs --admin-url http://127.0.0.1:${ADMIN_PORT}
```

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

## Live Alpha Migration Boundary

Temporary migration support is allowed during alpha only when it is named in the live boundary in `docs/specifications.md`.

Guardrails:

- New config, startup, persistence, or tool-surface compatibility must fail closed by default.
- Do not add speculative fallback readers, alternate owner paths, legacy env authority, direct-provider bypasses, or parallel persistence locations unless the support is first added to the live boundary with scope, validation, and beta-removal criteria.
- Existing compatibility that is not named in the live boundary should not be expanded. Treat it as removal debt and track it before beta.
- Production remains stricter than continuous/local mode: shared-root `DATA_DIR`, partial split-root config, overlapping roots, malformed owner files, and missing security-sensitive dependencies must fail closed.

## Supply Chain Pinning

- Do not use floating dependency or image references such as `latest`, `main-latest`, branch names, or unpinned aliases.
- When adding or updating external packages, container images, or fetched artifacts, pin them to an exact version. Prefer immutable digests for container images when operationally practical.
- Do not widen version ranges as part of routine maintenance. If you touch a dependency for security or upgrade work, land it as an exact pin in the repo.
- Treat floating upstream refs as a supply-chain risk. Replace them instead of preserving them.

## Structure Requirements

- Do not create or expand god files.
- Prefer focused modules with clear ownership boundaries.
- Extend existing primitives before inventing new parallel abstractions.
- Reuse shared type guards instead of redefining them locally. For example, use `isRecord` from `src/shared/utils/types.ts` rather than adding per-file `function isRecord` copies. If you need a new guard, add it to the shared utils module once and import it everywhere (see bead `psfn-framework-qfa`).
- If a file is getting large, split by domain capability before adding more.
- Verify new runtime code is wired to a real entrypoint or registry path.
- Before closing work, confirm there are no unreachable production modules or unwired settings.

## Bead Quality

Do not be stingy with beads. This is the single biggest source of backlog rot: a one- or two-sentence description cannot carry enough context to survive a later review, so the same work gets re-beaded under a slightly different name and nobody notices until an audit surfaces the duplicate.

Every bead must be self-contained enough that an agent can execute it correctly from the bead alone:

- **Full description, not a summary.** If the user rambles for two minutes with five concrete details, all five go in the description. Capturing the gist is not enough. Capture the detail.
- **Concrete file paths and line numbers** where known. Do not write `"fix the memory store"`; write `"src/faculties/memory/store/trust-filters.ts:20"`.
- **The why, not just the what.** A fix without the reason it matters breeds misimplementation and follow-up beads filling gaps that a clear bead would have prevented.
- **Explicit scope and non-goals.** State what is in and what is deliberately out, so the worker does not expand scope and so reviewers can tell whether a PR over- or under-shoots.
- **Acceptance criteria are mandatory.** Use `--acceptance`. "Done" must be checkable, not vibes. Without it an agent can implement the wrong thing and honestly call it closed.
- **Title must match priority.** A title prefixed `P0:` that sits at bead priority P1 is invisible in triage. If the title says `P0:`, the priority is 0; otherwise drop the prefix.
- **Close epics when their work is done.** An epic with all children closed, or whose scope is fully delivered, must be closed. Do not leave empty epic shells tracking nothing — they inflate the backlog and hide the real open work. Before leaving an epic open, confirm it still has live children or genuinely pending scope.
- **Close work that is already shipped.** If the code the bead describes already exists (verify in the repo, not by guessing), close the bead as done with the verification recorded in the close reason. Stale open beads describing implemented features are as bad as missing ones — they make the backlog look bottomless and trigger duplicate re-beads.
- **Retire dead planning concepts.** When the project changes how it plans (for example, the move from numbered phases to named sprints), the old planning artifacts are obsolete. Close them rather than letting them rot; reopen and re-scope under the current model only if the specific work is still wanted.

Before creating a bead, search for existing work first (`bd search`, scan the open list by normalized title). If the work already exists under a different phrasing, extend that bead's description instead of creating a duplicate. Duplicates are debt: they hide dependencies, split effort, and make the backlog look twice as large as it is.

Break large work into small, quickly-completable parts — but each part still carries the full context above. Small is about scope and verifiability, not about thinness of description.

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

Do not add AI-generated planning, audit, review, or scratch documents to tracked product docs unless the user explicitly asks for a repo-visible artifact.

Use beads for tracked work and keep transient planning in the session when possible. If a scratch repo-local document is explicitly needed, put it under `working_docs/`.

Do not use `history/` or `working_doc/` as dump directories.

If the user explicitly requests a repo document, use the location they specify. If they do not specify a location, ask before creating it.

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
- For this repo, put parallel worktrees under `$HOME/ai/dev/worktrees/psfn-framework` unless the user explicitly asks for a repo-local `worktrees/` directory instead.
- Do not scatter PSFN worktrees under sibling project-storage paths such as `/mnt/samesung/ai/psfn-worktrees`.

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
4. Commit bead database state to the local shared Dolt server:
   ```bash
   bd dolt commit --json
   ```
5. Push git state:
   ```bash
   git pull --rebase
   git push
   git status
   ```
6. Push bead state only if a Dolt remote is actually configured:
   ```bash
   bd dolt remote list --json
   # bd dolt push --json
   ```
   If the remote list is empty/null or shows `(none)`, skip `bd dolt push`; the local shared Dolt server is still the authoritative bead store for this checkout.
7. When a sprint or implementation wave is completed, refresh the kanban export:
   ```bash
   bd export > .beads/issues.jsonl
   ```
   Do not stage `.beads/issues.jsonl`; `.beads/` is ignored local export/runtime state.
8. When a sprint or implementation wave is completed, run a Fallow pass and review high-signal findings:
   ```bash
   npx -y fallow --format json > /tmp/fallow-report.json
   ```
9. Verify the branch is up to date with origin.
10. Clean up orchestration handles.
11. Hand off with tests run, remaining risks, and any open beads.

Rules:

- Never stop at "ready to push". Push.
- If push fails, resolve it and retry.
- Keep bead state aligned with the shipped git state.
- If a sprint or implementation wave closes tracked work, refresh `.beads/issues.jsonl` from the final bead database state before handoff.
- Never force-add or commit `.beads/`; it is intentionally ignored because the live bead source of truth is the local shared Dolt server.
- Treat Fallow as sprint or implementation-wave wrap-up hygiene, not a mandatory per-change gate.
- Do not close a worker bead before its worktree has a passing `npm run lint` result.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt commit
   bd dolt remote list
   # Only run this when the remote list shows a configured Dolt remote.
   # bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
