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
- A missing Dolt remote named `origin` is not a problem by itself. Do not run or report `bd dolt push` unless `bd dolt remote list --json` shows an actual configured remote. Historical incident: pushing without a real remote recreated junk `__dolt_remote_info__` / `refs/dolt/*` refs on GitHub that had to be deleted by hand.
- `.beads/` is intentionally ignored local runtime/export state. Never `git add .beads`, never force-add `.beads/issues.jsonl`, and do not treat ignored `.beads` changes as code dirt.
- Keep `bd config get export.git-add` at `false`; otherwise `bd` will try to stage ignored `.beads/issues.jsonl` exports and create noisy false warnings.
- **Remote-lane issues.jsonl sync convention.** Agent lanes that cannot reach the local shared Dolt server (off-machine instances working against `origin`) sync bead state through the committed `.beads/issues.jsonl` snapshot instead — this is why `.gitignore` un-ignores that one file (`!.beads/issues.jsonl`) while ignoring the rest of `.beads/`. Such a lane must `bd import .beads/issues.jsonl` after every `git pull` (upsert semantics) and, after closing its beads, `bd export > .beads/issues.jsonl` then commit and push that file. The "never stage `.beads/issues.jsonl`" rule above is for lanes with direct Dolt access, where Dolt is authoritative and committing the export only creates noise; it does not forbid the remote sync lane from committing that single un-ignored file.
- Do not create markdown TODO lists or external task trackers.
- If `bd ready --json` is empty but you are doing user-requested tracked work, create a self-contained issue before editing code.
- Link discovered follow-up work with `discovered-from:<parent-id>`.
- Keep issue descriptions self-contained: summary, files, concrete steps, and an example when useful.
- **Label taxonomy (apply at creation).** Every bead carries two labels — a `kind` and a `system` — set with `bd create ... -l kind:<kind>,system:<system>`:
  - `kind` ∈ `bug` | `feat` | `chore` | `design` (the scannable category; orthogonal to bd's `-t` type, which stays `bug`/`feature`/`task`/`epic` for workflow).
  - `system` ∈ `memory` | `session` | `scheduler` | `garden` | `helm-ops` | `agent-tooling` | `metacog` | `emotion` | `channels` | `cogsec` | `persistence` | `voice` | `world` | `docs` | `fleet-auth` | `companion-ui` | `icp` | `shards` | `prompts` | `testing`.

  This makes a bare `bd list` row self-describing and lets triage filter, e.g. `bd list --label kind:bug --label system:memory` (AND) or `bd list --label-pattern 'system:*'`.

## Source Of Truth

Prefer these files when checking behavior:

1. Runtime entrypoints and wiring
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/operator/main.ts`
   - `src/app/startup/composition/composition.ts`
2. Config and ownership contracts
   - `src/shared/contracts/runtime.ts`
   - `src/system/config/runtime-config-contracts.ts`
   - `src/system/config/load-config.ts`
   - `src/system/config/settings-contract-guard.ts`
   - `src/system/config/startup-owner-files.ts`
   - `src/system/settings.ts`
   - `src/system/settings/contracts.ts`
   - `src/persistence/layout.ts`
   - `src/persistence/runtime-factory.ts` (Postgres-only runtime persistence)
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
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `intake-policy.json`
- `charge-policy.json`
- `backup.json`

Companion state belongs under `companion-data`.

`WORKSPACE_PATH` is one companion's Personal Workspace, not a runtime-state
root or a general shared-files root. For the live Purrsephone deployment, this
is repo-root `purrsephone/`. Personal documents, generated/saved images,
downloads, personal knowledge-base notes, scratchpad/journal files, authored
personal skills, modules, and experiments belong there. Runtime owner files,
databases, L0/session state, telemetry, backups, active identity artifacts, and
system/default skill config belong in `DATA_DIR` or split system/companion
runtime roots.

In the multi-companion runtime, the cluster launcher derives and validates one
Personal Workspace per companion beneath the runtime root, injects only that
root as the process `WORKSPACE_PATH`, and exposes the separate Shared Companion
Workspace through its governed Garden surface. Do not add manifest path
overrides, a `SHARED_WORKSPACE_PATH` environment variable, or ad hoc shared
roots; shared material must retain review, provenance, and CogSec policy.

Guardrails:

- If only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set, startup must fail.
- Production layout roots must not overlap.
- `WORKSPACE_PATH` must not overlap `DATA_DIR`, `SYSTEM_DATA_DIR`, or `COMPANION_DATA_DIR`.
- New settings must be wired through the owner-file contract, Garden exposure, and tests.
- Run `npm run verify:settings-contract` when touching settings or settings UI.
- `npm run verify:hardcoded-settings` (in the `verify:repository-hygiene` chain) fails closed when a new module-level scalar `const` with a tuning/policy-flavored name appears in `src/` (object-literal members, `let`, enum/class fields are outside the scanner's scope — reviewer judgment still applies there) that is neither settings-owned nor recorded in `scripts/hardcoded-settings-baseline.json`. When you add a genuinely code-owned tuning constant, run `npm run verify:hardcoded-settings -- --update` and justify the baseline addition with a one-line `note`; otherwise migrate the constant to an owned setting.

## Live Deployment Boundary

For the live running app in this repo, everything operationally authoritative must live under this repo tree.

**Live authority is k3s, not host systemd.** The live companion runs as the k3s
deployment in namespace `psfn` (agent, gateway, and Garden workloads from
`deploy/helm/psfn`), with the system-owned owner files mounted at
`/runtime/system-data` from the system-data PVC and all persistent state on
Kubernetes PVCs. The host `psfn.service` systemd unit and its on-host
`/var/lib/psfn/runtime/system-data` tree are disabled, non-authoritative legacy
unless an operator explicitly reactivates them. Before any live owner-file or
persistence change, discover the running workloads and inspect owner-file hashes
read-only against the k3s namespace (see `docs/operations.md` → "Live deployment
authority" for the exact commands); do not mutate the host tree assuming it is
live.

Rules:

- Do not create, edit, or rely on live runtime/service/env config outside this repo tree without explicit user permission.
- Forbidden without explicit permission: `~/.config/systemd/user/*`, home-directory env files, ad hoc supervisor drop-ins, and any other off-repo runtime overrides.
- Do not create shadow copies of live unit files, env files, or runtime wiring in `$HOME`, `/tmp`, or other side locations just to avoid a restart or make a workaround stick.
- If the live service must change, change the repo-owned file in this directory and restart the service if needed. A required restart is acceptable; hidden off-repo config is not.
- If the supervisor requires a registration artifact outside the repo, it must only be a thin pointer to a repo-owned file, never the authoritative config itself, unless the user explicitly approves otherwise.

## Private Deployment Data

Tracked agent instructions must not contain live hostnames, SSH aliases, device
identifiers, private addresses, mount points, or operator home paths. Keep that
deployment-specific evidence in the ignored repo-local note described by
`working_docs/private-live-ops.example.md`, and supply script inputs through
environment variables or `scripts/ops/private-ops.env`.

Do not copy values from the private note back into tracked files, test fixtures,
examples, or comments. Public examples must use placeholders or reserved
documentation addresses.

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

## Delivery Loop

The point is to get work DONE and shipped, then iterate — not to polish in place. The full wave protocol (roles, lane tables, branch shape, review/remediation loop, fix epics, validation separation, push policy) is **[`docs/orchestration-process.md`](./docs/orchestration-process.md)** — the operating contract for multi-agent implementation waves. Summary of the load-bearing rules:

- **Roles**: Codex (`gpt-5.6-sol`, xhigh) is the primary implementer; Opus 4.8 (high) and the Pi agent (GLM 5.2, xhigh) are the two adversarial reviewer lanes; the orchestrator plans, dispatches, synthesizes, and integrates but does not implement or bulk-read code. Claude-side tool wiring lives in CLAUDE.md.
- **Adversarial review**: reviewer lanes review the same immutable commit range independently and blind to each other, prompted to refute with concrete failure scenarios. The orchestrator dedupes and **independently verifies every claimed blocker** against the Blocking Risk Standard before remediation — reviewers systematically over-grade severity.
- **Bounded loop**: implement → reviews → **one remediation pass** (verified IMPORTANT/P0-P1 findings only) → one final check → move on. No successive review/remediation cycles.
- **Minimize paid review cycles**: when a small follow-up correction is discovered while a suitable related PR is still open, update that existing PR instead of opening a standalone PR. Validate corrections locally before publishing; do not create extra PRs for fixes that can safely ride an existing in-scope PR.
- **IMPORTANT ≙ P0/P1** and only for: partner-data security/privacy/isolation, companion welfare/consent/autonomy, real data loss or secret exposure, a broken core acceptance path, or a mandatory gate (lint).
- **Leftover IMPORTANT defects** go to the wave's `<wave> fixes` epic for a fresh agent and block the affected PR; implementation closes after the fixed delivery merges. **Nonblocking observations go in the handoff report only — never beads, never merge blockers.**
- For high-risk areas (config ownership, gateway policy, trust/privacy, persistence, deployment, durable memory writes) and recurring bug classes, additionally apply `docs/adversarial-review-and-bugfixing-practices.md`; consult it when the task warrants, not at every session start.

## Local-First Delivery And GitHub Confirmation

Install this repository's delivery hooks once per worktree after `npm ci`:

```bash
npm run hooks:install
```

The installer refuses to disable any existing hook or replace an existing
`gh gated-pr` alias. It configures the tracked `.githooks/pre-push` hook for the current
worktree and installs `gh gated-pr` as the supported PR publisher.

Keep changes reviewable without buying a separate paid review for every tiny
patch:

- Normal PR target: at most 25 files, 1,500 counted changed lines, and 5 commits.
- Hard PR limit: 25 files, 2,000 counted changed lines, or 8 commits.
- Hard per-commit limit: 15 files or 800 counted changed lines.
- Each commit must be one coherent change. Do not mix unrelated beads,
  remediation, generated artifacts, or another branch's history into it.
- Batch compatible small beads into one coherent review and deployment unit.
  Do not open a standalone paid-review PR for a routine tiny patch merely
  because it has its own bead. A small standalone PR is appropriate only when
  it is urgent, independently releasable, or unsafe to batch.
- Use an integration branch only when partial delivery to `main` is genuinely
  unsafe. The final coherent PR still obeys the normal limits.

Before any branch push or PR publication, the exact clean commit must pass
`npm run gate:pre-pr`. The pre-push hook runs it automatically and caches an
attestation by exact head and base SHA. Never use `--no-verify`. The gate owns
delivery-rule tests, the change budget, changed-file lint, Semgrep diff scanning,
changed-file UBS, and changed-workflow lint. Full root lint, build, typecheck,
repository hygiene, and product tests run only for root runtime/build-graph or
root lockfile changes. UI and deployment changes use their focused specialist
checks instead of the backend/Postgres suite. Semgrep rule tests run only when
the rules change. A new commit or base change invalidates the attestation.

Publish with the repo wrapper; do not use raw `gh pr create` or `gh pr edit`:

```bash
gh gated-pr --title "<title>" --body-file <path>
```

The wrapper reuses the exact-head local attestation, pushes without recursively
rerunning the gate, publishes an authenticated exact-head/base commit status, and waits
for both `ci-required` and `Greptile Review`. A failure returns immediately to
the publishing agent; it never reruns CI, re-requests Greptile, or starts a new
review/remediation cycle. Fix the same branch, create one new commit, run the
bounded final check, and publish that new exact head once.

GitHub CI is deliberately complementary: it validates that commit status and
change budget, then uses one clean-environment runner for scoped root builds,
UI checks, or deployment contracts when those paths changed. It never runs the
full repository product/Postgres suite. It
does not duplicate local full lint, typecheck, repository hygiene, UBS, or
Semgrep; scoped clean-environment UI and deployment checks complement their
local specialist gates. Label changes do not retrigger CI. Greptile remains the
paid external review.

All repository changes go through a PR. Never push directly to `main`. Before
merge, verify both required checks on the exact PR head:

```bash
npm run pr:wait -- --pr <number> --head "$(git rev-parse HEAD)"
```

Use GitHub's rebase merge so the small, coherent source commits remain small on
`main`. Do not squash a multi-commit PR into one oversized commit, and do not
create merge commits.

If GitHub billing, Actions, Greptile, required status checks, or rulesets are
unavailable, stop. The platform limitation does not relax this contract and is
not permission to rerun paid services in a loop.

The portable setup and internal reviewer procedure are documented in
[`docs/internal-review-workflow.md`](./docs/internal-review-workflow.md).

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

### Verifying done before closing (read the code, one at a time)

The fastest way to wreck a backlog audit is to close beads by guessing. A grep that returns empty is not evidence the work is unbuilt; a folder that exists is not evidence the feature shipped. Both directions produce false verdicts, and false verdicts cost hours of re-checking.

When deciding whether an open bead is done:

1. **Check commit history first.** `git log --oneline -i --grep="<keyword>"` is the single highest-signal source of truth. If a commit titles the work, it almost certainly landed. Read the commit's `--stat` to see which files it touched.
2. **Then read the actual source the bead cites.** Open the file, read the cited lines, confirm the feature is implemented — not just that the file exists or that a related symbol appears. A partial implementation is not done.
3. **One bead at a time.** Do not batch-grep a list of beads and stamp verdicts from the grep output. Batch-grepping is what produces the overcalls and undercalls this project has already paid for. Read each bead's description against the code before closing it or leaving it open.
4. **Record the evidence in the close reason or notes.** Name the commit hash and the file:line that proves the work shipped. A close without evidence is a guess that someone else has to re-verify.
5. **When the premise is dead, say so explicitly.** If a bead describes SQLite work on a runtime that is now Postgres-only, do not silently close it as done. Close it as obsolete with the premise named (e.g. "premise dead: SQLite file retired by 3c2.5"), and if a real Postgres-scoped version of the same problem exists, track it as a new bead rather than carrying the stale one.
6. **Subjective scope cannot be self-verified.** If a bead has no acceptance criteria and asks for a judgement call ("improve discoverability", "revamp IA"), do not close it on your own read. Leave it open and flag it as an operator decision.

The rule is simple: if you have not read the commit and the code for a specific bead, you have not verified it. Do not close it.

## Validation Expectations

If your change touches code, run the smallest set of quality gates that proves it.

During implementation, run focused tests and changed-file lint for quick
feedback. At a stable PR-ready commit, the local gate is mandatory:

```bash
npm run gate:pre-pr
```

The gate always runs delivery-rule tests, budget, changed-file lint, Semgrep
diff scanning, and changed-file UBS. It adds full root gates only for root
runtime/build-graph or lockfile changes, and focused UI, deployment, workflow,
settings, or supply-chain checks only when their paths changed. Do not
close, integrate, push, or publish tracked work if it fails. Logs and the
exact-head attestation live in the worktree's Git directory, not in tracked
files.

No worker or sub-agent may mark a bead done or ask for integration until its
targeted checks and local gate pass. Do not close the bead until the PR's exact
head has both `ci-required` and `Greptile Review` green and the change is
integrated as required by the bead's delivery scope.

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

- Prefer coherent review units near the normal 25-file/1,500-line budget.
  Batch compatible small beads instead of opening one paid-review PR per bead.
  Create a dedicated integration branch when partial delivery is unsafe or the
  effort requires combined manual verification.
- Create each worktree from the integration branch and merge each completed stream back into the integration branch, not directly into the protected release branch.
- Keep the release branch stable while the parallel effort is in flight. Merge the integration branch into the release branch only after the user or operator finishes the required manual verification.
- For this repo, put parallel worktrees under `$HOME/ai/dev/worktrees/psfn-framework` unless the user explicitly asks for a repo-local `worktrees/` directory instead.
- Do not scatter PSFN worktrees under sibling project-storage paths such as `/mnt/samesung/ai/psfn-worktrees`.

### Standard parallel loop

1. Select the next highest-priority ready beads that are safe to run in parallel.
2. Create one worktree per selected bead or stream.
3. Spawn at most one sub-agent per worktree and give it explicit ownership of its bead, files, and validation scope.
4. Require each sub-agent to implement only its assigned bead, run targeted validation, and commit its work inside its own worktree. The assembled PR-ready branch must pass the local gate before push.
5. Let the streams run without constant check-ins. Do not micro-manage active workers; check on them only when they report a blocker, finish, or have been silent for an unusually long interval such as 20 minutes.
6. When the selected streams are complete, merge them back into the integration branch and resolve conflicts only at the orchestrator level.
7. Run validation on the integration branch for every merged area, plus broader regression coverage when the combined change surface warrants it.
8. Update bead state after integration: close completed beads with evidence, and reopen or create follow-up beads when new work is discovered.
9. Repeat with the next set of ready beads until the non-deferred work for the initiative is complete.

### Merge and validation policy

- Merge blocker-unlocking or dependency-clearing beads first when merge order matters.
- If two streams conflict, resolve the conflict once on the integration branch and rerun the impacted tests there.
- Do not close a bead without validation evidence for the area it changed.
- Do not integrate a worker change unless targeted validation passed. Do not
  publish the assembled branch until the local gate passes, and do not close its
  beads until both `ci-required` and `Greptile Review` pass on the exact PR head.
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
2. Run targeted checks while developing, then commit the PR-ready exact head.
3. Rebase on the current remote base and run `npm run gate:pre-pr`.
4. Update bead status, but keep delivered work open until its exact PR head is
   green and integrated.
5. Commit bead database state to the local shared Dolt server:
   ```bash
   bd dolt commit --json
   ```
6. Publish or update the PR through the guarded wrapper:
   ```bash
   gh gated-pr --title "<title>" --body-file <path>
   ```
   This pushes the attested head and waits for `ci-required` and Greptile. Do
   not run a second watcher or rerun failed checks.
7. Merge only after both checks pass, then close the delivered beads with
   commit, file, local-gate, PR-head, and merge evidence.
8. Push bead state only if a Dolt remote is actually configured:
   ```bash
   bd dolt remote list --json
   # bd dolt push --json
   ```
   If the remote list is empty/null or shows `(none)`, skip `bd dolt push`; the local shared Dolt server is still the authoritative bead store for this checkout.
9. When a sprint or implementation wave is completed, refresh the kanban export:
   ```bash
   bd export > .beads/issues.jsonl
   ```
   Do not stage `.beads/issues.jsonl`; `.beads/` is ignored local export/runtime state.
10. When a sprint or implementation wave is completed, run a Fallow pass and review high-signal findings:
   ```bash
   npx -y fallow --format json > /tmp/fallow-report.json
   ```
11. Verify the merged branch is up to date with origin.
12. Clean up orchestration handles.
13. Hand off with tests run, remaining risks, and any open beads.

Rules:

- Never stop at "ready to push". Push.
- If push fails, resolve it and retry.
- Keep bead state aligned with the shipped git state.
- If a sprint or implementation wave closes tracked work, refresh `.beads/issues.jsonl` from the final bead database state before handoff.
- Never force-add or commit `.beads/`; it is intentionally ignored because the live bead source of truth is the local shared Dolt server.
- Treat Fallow as sprint or implementation-wave wrap-up hygiene, not a mandatory per-change gate.
- Do not close a worker bead before targeted validation, the exact-head local
  gate, `ci-required`, Greptile, and the required integration pass.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
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

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
