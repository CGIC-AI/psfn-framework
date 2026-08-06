# Agent Instructions

## Purpose and precedence

This is the repository map and operating contract for coding agents. Use it with
the current code, not instead of it. Current operator instructions win; runtime
and configuration contracts win when prose has drifted.

Load detailed workflow documents only when the task needs them:

- Multi-bead or multi-PR implementation wave: [`docs/orchestration-process.md`](./docs/orchestration-process.md)
- Portable gate/reviewer setup: [`docs/internal-review-workflow.md`](./docs/internal-review-workflow.md)
- High-risk review practices: [`docs/adversarial-review-and-bugfixing-practices.md`](./docs/adversarial-review-and-bugfixing-practices.md)
- Live operations: [`docs/operations.md`](./docs/operations.md)

## Implementation first: process must earn its cost

This project is functionality-constrained, not ceremony-constrained. Optimize for
working, shipped behavior. A process action is justified only when it prevents a
specific plausible defect, protects work from loss, or coordinates genuinely
concurrent writers. Producing more tracker, review, bus, gate, or status artifacts
is not progress by itself.

Hard stopping rules:

- Start the first useful source or test edit after the minimum safe setup: inspect
  the target, run `bd prime`, read/claim the existing bead (or create one), and
  verify the branch/worktree. For an ordinary fix this should take minutes, not a
  review cycle.
- If setup and coordination consume 10 minutes before implementation starts, or
  non-implementation work exceeds roughly 25% of the active task time, stop every
  optional process activity and return to implementation. State the concrete
  blocker if implementation truly cannot proceed.
- Tracker priority is product priority, not automatic review intensity. A P0/P1
  label alone never requires extra agents, model reviews, broad tests, or a
  separate PR.
- Small or low-risk changes use one implementer, one branch, focused tests, and no
  model reviewer, agent bus, or clean-main canary unless a concrete risk or current
  operator instruction requires one. Worktree isolation is separate from review
  ceremony: whenever agents or subagents write concurrently, every writer uses its
  own branch and worktree, including work in overlapping systems.
- Review the assembled PR train at most once, and only when its actual trust
  boundaries or complexity justify review. Do not review every bead and then
  review the same code again as an epic or train.
- Run the broad pre-PR gate once on the final committed train head. Never run it
  on worker checkpoints, and do not rerun an unchanged attested head.
- When compatible fixes are ready, batch them into one train up to the hard PR
  limits. The 800-line publication floor exists to prevent tiny PRs from creating
  separate paid-review events; use its documented blocker exception, never filler,
  when a smaller change genuinely must land alone.
- Publishing, CI, external review, and merging are asynchronous boundaries. After
  creating the PR, report its URL and move to the next implementation task. Do not
  babysit checks or wait for Greptile unless the operator explicitly asks.
- Greptile is paid and opt-in. Never add `review:greptile`, mention the bot, or
  otherwise trigger it unless the operator explicitly requests that paid review.
  A P0/P1 label, PR publication, or `--wait` is not authorization.
- When the operator says ship, publish, hurry, or stop reviewing, all optional
  review and documentation work stops immediately. Finish only the minimum safe
  validation and delivery actions requested.

## Route the task first

- **Read-only answer, diagnosis, or review:** inspect freely. Do not create or
  claim a bead unless the operator asks to track the work. Unrelated worktree
  changes are not a blocker; preserve them and do not stage or modify them.
- **Single implementation or fix:** run `bd prime`, inspect or create the bead,
  claim it, work on a named non-main branch, run focused validation, commit, and
  push the checkpoint.
- **Several independent beads or a sprint wave:** read the orchestration process
  before fanout. Parallelize only independent seams and only when it reduces wall
  time after including setup and integration cost.
- **Live owner-file, persistence, or deployment work:** read the live authority
  section below and `docs/operations.md` before any mutation.

## Delivery authority: remote by default

This repository opts into the **team-maintainer** profile.

- Agents are authorized and required to commit coherent checkpoints and push
  every non-main work branch. Work left only in a local worktree is not saved.
- Direct pushes to `main` are prohibited. Delivery to `main` uses a PR unless the
  current operator explicitly authorizes a direct-main exception.
- A checkpoint push is remote backup, not publication. It does not claim that
  broad gates or review passed.
- Before publication, run `npm run gate:pre-pr` once on the exact final committed
  head and publish through `npm run pr:publish`.
- Never manually force-push or rewrite a shared branch. Rebase before publication
  when the base moves; the exact-head `pr:publish` wrapper alone may update that
  branch with an attestation-checked, exact-remote `--force-with-lease`.
- A parked lane is still remotely durable: its bead note records the remote
  branch, exact pushed head, validation state, and blocker. Local-only parking is
  forbidden.
- Reserve **done** for code present on `main` with the bead closed. Earlier states
  are `implemented`, `checkpoint-pushed`, `gated`, or `published, awaiting checks`.

## Beads issue tracking

Run `bd prime` at the start of tracked work. Use `--json` for programmatic
operations and never use the interactive `bd edit` command.

```bash
bd ready --json
bd show <id> --json
bd update <id> --claim --json
bd create "Title" --description "Self-contained task details" \
  --acceptance "Checkable completion criteria" -t task -p 2 \
  -l kind:chore,system:agent-tooling --json
bd close <id> --reason "Commit, validation, and delivery evidence" --json
bd dolt commit --json
```

Rules:

- Use Beads for durable shared work; do not create Markdown TODO trackers.
- Search before creating. Extend existing work instead of duplicating it.
- If user-requested implementation has no existing bead, create and claim one
  before editing.
- Keep bead operations compact: one claim, meaningful checkpoint/delivery notes,
  and closure evidence. Do not narrate every command or mirror transient local
  state into the tracker.
- Every bead needs the why, concrete files, scope and non-goals, acceptance
  criteria, and enough context for a zero-context agent.
- Link discovered work with `discovered-from:<parent-id>`.
- Every new bead has `kind:<bug|feat|chore|design>` and one `system:<system>`
  label. Current systems include `memory`, `session`, `scheduler`, `garden`,
  `helm-ops`, `agent-tooling`, `metacog`, `emotion`, `channels`, `cogsec`,
  `persistence`, `voice`, `world`, `docs`, `fleet-auth`, `companion-ui`, `icp`,
  `shards`, `prompts`, and `testing`.
- The local shared Dolt server is authoritative for this checkout. Commit local
  bead changes, but do not run `bd dolt push` unless the operator explicitly asks;
  the configured origin may be stale or misleading.
- Keep `bd config get export.git-add` at `false`. Do not stage ignored `.beads/`
  runtime/export state in a direct-Dolt lane.
- Remote-only lanes import the committed `.beads/issues.jsonl` after pulling and
  export, commit, and push that single snapshot after closing work. This exception
  does not apply to lanes with direct shared-Dolt access.

When verifying whether an old bead is already delivered, work one bead at a
time: read its acceptance criteria, inspect matching commit history, read the
actual source and tests, and record concrete evidence. Do not close from grep
results or file existence alone.

## Source of truth

Prefer these files when checking behavior:

1. Runtime entrypoints and wiring
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/operator/main.ts`
   - `src/app/startup/composition/composition.ts`
2. Configuration and ownership contracts
   - `src/shared/contracts/runtime.ts`
   - `src/system/config/runtime-config-contracts.ts`
   - `src/system/config/load-config.ts`
   - `src/system/config/settings-contract-guard.ts`
   - `src/system/config/startup-owner-files.ts`
   - `src/system/settings.ts`
   - `src/system/settings/contracts.ts`
   - `src/persistence/layout.ts`
   - `src/persistence/runtime-factory.ts` (Postgres-only runtime persistence)
3. Product and runtime documentation
   - `README.md`
   - `docs/specifications.md`
   - `docs/architecture.md`
   - `docs/memory.md`
   - `docs/operations.md`
   - `docs/setup.md`
4. Bootstrap examples only
   - `.env.example`

Do not treat `.env.example` as authority for mutable settings.

## Configuration and workspace ownership

Use `.env` only for secrets, host/port/socket wiring, runtime layout wiring, and
explicit env-owned bootstrap overrides.

Mutable settings belong in canonical system owner files: `settings.json`,
`models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`,
`channels.json`, `skills.json`, `trust-policy.json`, `intake-policy.json`,
`charge-policy.json`, and `backup.json`.

`WORKSPACE_PATH` is one companion's Personal Workspace. It is not runtime state
or an ad hoc shared root. Runtime owner files, databases, sessions, telemetry,
backups, active identity artifacts, and system/default skills belong in
`DATA_DIR` or the split system/companion roots. Shared companion material goes
through the governed Garden surface; do not invent `SHARED_WORKSPACE_PATH` or
manifest path overrides.

Fail startup when:

- only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set;
- production roots overlap; or
- `WORKSPACE_PATH` overlaps any runtime data root.

New settings must be wired through the owner-file contract, Garden exposure, and
tests. Run `npm run verify:settings-contract` for settings/config changes.

## Live deployment and private data

The live authority is the k3s deployment in namespace `psfn`, not host systemd.
System owner files and persistent state live on Kubernetes PVCs. Before a live
owner-file or persistence change, discover the running workloads and inspect
owner-file hashes read-only using `docs/operations.md`.

- Do not mutate the legacy host tree assuming it is live.
- Do not create authoritative runtime/service/env config outside the repository
  without explicit permission.
- Do not create shadow config under `$HOME`, `/tmp`, supervisor drop-ins, or
  side directories to avoid a restart.
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

## Implementation standards

1. Security and policy fail closed.
2. Do not swallow errors.
3. Do not add legacy paths, compatibility shims, or silent fallbacks unless the
   live alpha migration boundary in `docs/specifications.md` explicitly names
   them with validation and removal criteria.
4. Unknown plugin, provider, owner, capability, or confirmation data rejects.
5. Extend existing primitives before creating parallel abstractions.
6. Do not create or expand god files. Split by domain capability.
7. Reuse shared guards such as `isRecord` from `src/shared/utils/types.ts`.
8. Verify new runtime code is reachable from a real entrypoint or registry.
9. Pin dependencies, images, and fetched artifacts exactly. Do not use `latest`,
   branch refs, unpinned `npx`, or floating remote installers.

For code-owned tuning and policy values, comply with
`npm run verify:hardcoded-settings`; settings-like values belong in owner files.
The AST-based gate covers literal numeric/string/regex declarations at any
scope (including `let`/`var`), literal string/number arrays and readonly tuples,
tuning-bearing object members, enum/class fields, and statically embedded
`CHILD_SOURCE`/`WORKER_SOURCE` templates. It deliberately keys on policy-shaped
identifier segments and ignores derived values, calls, spreads, and identifiers
as direct values, except for policy-shaped `RegExp` constructors; mixed objects
are traversed so their literal policy members remain visible. Extended-form
baseline entries require a non-empty review note.

The gate also recognizes low-noise literal policy shapes at call sites: nontrivial
timer delays, content truncation, `Math.min`/`Math.max` clamps, retry/options
call-object members, nontrivial `.length` guards, and policy-context return
arithmetic. These entries use stable scope/shape/occurrence identities rather
than line numbers. Test/E2E support, 0/1 structural guards, array indices,
hash/UUID/date protocol slices, ordinary arithmetic, and identifier-derived
values are excluded. `--update` may write the mechanical inventory, but exits
nonzero until every new extended-form entry has a reviewed justification note;
it never invents or silently accepts code ownership. Run
`npm run verify:hardcoded-settings -- --help` for the compact scanner contract.

Structural hygiene gates under `verify:repository-hygiene` include:

- `verify:knip`, which rejects new unused files, exports, and types. Regenerate
  a reviewed reduction with `npm run verify:knip -- --update`.
- `verify:duplicate-type-names`, which rejects new exported
  `interface`/`type`/`enum` duplicates or shape collisions. Existing debt is
  recorded in `config/duplicate-type-baseline.json` with mandatory review notes.

These baselines are reduction-only. Fix the source or remove resolved entries;
do not grow a baseline to silence a gate.

Structural hygiene under `verify:repository-hygiene` also includes
`verify:todo-bead-links`. Every `TODO`, `FIXME`, `HACK`, or `XXX` source comment
must name its owning Bead in parentheses. Its reviewed baseline is
reduction-only: `npm run verify:todo-bead-links -- --update` may prune stale
entries, but it refuses additions.

## Validation and publication

During implementation, run targeted tests and changed-file lint. Do not run the
broad suite after every edit or checkpoint push.

Before publication:

1. Fetch and rebase onto the intended base.
2. Commit the exact clean head.
3. Run `npm run gate:pre-pr` once; it owns broad PREFLIGHT and HEAVY validation.
4. Publish only with `npm run pr:publish`.
5. Return the PR URL. CI continues asynchronously; use `--wait` only when the
   operator explicitly asks this session to monitor required checks.

The mandatory publication window is 800–2,500 counted changed lines, at most 25
files, and at most 8 commits. Fifteen files, 1,500 lines, and 5 commits are
planning targets, not limits. A coherent commit may span up to the PR hard limits.
Bundle compatible ready work to reach the floor; never add filler. A smaller PR
requires `change-budget:exception` and a `BLOCKER:` rationale explaining why it
must land alone and cannot safely wait for compatible work.

Integration-test timeout overrides must be registered in
`src/test-support/integration-timeout-registry.json`. Measure first and preserve
at least 2x headroom; never raise a timeout reactively.

## Git and parallel-work safety

Preserve work owned by other agents.

- Unexpected changes block edits, rebases, branch switches, or destructive Git
  operations only when they overlap the planned mutation or make it unsafe.
  Read-only inspection continues.
- Never delete branches, worktrees, stashes, or shared Git state without explicit
  operator approval.
- Forbidden without approval: branch deletion, worktree removal, stash drop or
  clear, `git reset --hard`, `git checkout -- .`, `git clean -f`, and recursive
  deletion of possible worktrees.
- Use worktrees under `$HOME/ai/dev/worktrees/psfn-framework` for parallel work.
- Every concurrent writer—including subagents—owns a distinct branch and
  worktree. This remains mandatory when lanes touch the same system or files;
  coordinate ownership and integrate explicitly instead of sharing a checkout.
- A single writer may implement several compatible beads sequentially in one
  train worktree. Do not create a worktree per bead when no writers overlap in
  time, and never edit another active lane's files.
- Prefer independent seams, but overlapping-system work may run concurrently when
  explicit ownership and integration ordering make it worthwhile. Three workers
  plus one orchestrator is the normal maximum, not a quota.

## Session handoff

Before ending tracked implementation work:

1. Commit and push every non-main branch checkpoint.
2. Record branch, exact remote SHA, validation, and blocker/next action on the bead.
3. Run the appropriate quality gates.
4. Publish or park remotely; leave nothing only in a worktree.
5. Close implementation beads only after delivery to `main` and required checks,
   or after an explicitly authorized direct-main hotfix with equivalent evidence.
6. Commit pending Beads state with `bd dolt commit --json`.
7. Report tests, remaining risks, open beads, and exact delivered head.

Do not remain idle after publication merely to observe CI, external review, or a
merge. Record `published, awaiting checks`, return the PR URL, and move on. The
merging session or a later reconciliation sweep closes delivered beads.

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads quick reference

Use the `beads` skill and `bd` CLI for durable tracking:

```bash
bd ready
bd show <id>
bd update <id> --claim
bd close <id>
bd prime
```

Use `bd remember` for durable project memory; do not create ad hoc memory files.
The managed Beads block is task-tracking guidance, not permission to override
current operator or repository instructions.
<!-- END BEADS CODEX SETUP -->

## The agent bus

The bus is optional coordination infrastructure, not a completion gate. Open one
only when two or more concurrent writers need durable cross-lane findings or
handoffs and the bus is cheaper than direct messages plus bead notes. Multiple
phases, multiple reviewers, or a single orchestrator do not by themselves justify
a bus.

If a run is justified, follow `~/agentbus/SCHEMA.md`, append only decisions or
findings another lane needs, and run `bus-lint` before the last writer leaves.
Do not install or operate an embedding model, run duplicate sweeps, or produce
per-command traffic unless the run's size has created an observed retrieval
problem. Bus maintenance must never delay implementation, validation, or PR
publication.
