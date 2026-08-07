# Lane 8 — AI Slop, Stubs, LARP & Comment Hygiene

Audit date: 2026-08-05. Branch: `feat/emosim-fleet-shakedown` (working tree as-is). Read-only.

## Scope & method

Examined: `src/` (all TypeScript, primary focus), `companion-ui/src`, `admin-ui/src`, `PSFN-Satellite-Hub`, `scripts/`, `docker/`, and a spot-check sample of `docs/`.

Commands/tools used (all read-only):

- `Grep`/`grep -rn` for markers: `TODO|FIXME|HACK|XXX`, `not implemented|unimplemented`, `placeholder|stub`, `WIP|for now|temporary`, `legacy`, `now wires|replaces the old|new implementation`, `console\.(log|debug|info)`, `encrypt|sandbox|fail-clos|tamper|audit`, `conversationScope`, `InMemoryRestWindowPolicy`, empty-body functions (`\) *\{\s*\}`), commented-out-code heuristic (`//\s*(const|let|function|if|return|await|import)`).
- Byte-level scan (python3) for NUL/control characters in every `.ts`/`.tsx` under `src/` — this is how the top finding was confirmed (grep/ripgrep silently degrade to "binary file matches" on these files).
- `git grep` / `git check-attr` to confirm the binary-file impact on VCS tooling.
- `bd show` / `bd list --json` (read-only) to verify whether in-code bead references and "dependent bead" promises actually exist in the tracker: `psfn-framework-htm9.2`, `-ls1k`, `-tc6nk`, `-7ym.2.1`, `PSFNLIVE-70nb`, `psfn-framework-zet.1`, plus searches for `shard_foldback`, `subagent_output`, `conversationScope` gate-flip beads.
- Deep reads: `src/faculties/context-feedback/runtime.ts` + `evaluator.ts` (full), `src/system/lifecycle/kube-auto-rollback.ts:270-330`, `src/app/operator/kube-self-update-job-main.ts:265-304`, `src/faculties/memory/retrieval/access.ts:30-90`, `src/core/session/manager-primitives.ts:1050-1114`, `src/core/agent/completion-handoff.ts:25-60`, `src/faculties/shards/fold-review.ts:1-40`, `src/boundary/gateway/system-data-writer.ts:95-130`, `src/system/config/load-config.ts:615-644`, `src/shared/logger.ts:1-60`, `src/faculties/memory/journal.ts:1-30`, `docs/development-status.md` (head), `docs/memory.md` (L0 sections).
- Prior audits in `working_docs/READONLY_AUDIT_*_20260721.md` consulted for leads (PM-5, W2); both re-verified against current code.

Coverage limits: did NOT run the test suite, builds, or gates. Docs spot-check only (development-status, memory, specifications, cognitive-security adjacent material) — not an exhaustive docs audit. `PSFN-Satellite-Hub` received marker greps only (all clean). Did not audit `shakedown/` in depth.

Headline: this codebase is unusually clean for its size. Comment culture is strong — the overwhelming majority of comments are genuine WHY-comments encoding threat models, welfare rationale, and bead provenance. I found one systemic hygiene defect (literal NUL bytes), one stale comment that contradicts shipped code, three untracked security TODOs, and minor docs drift. No theatrical capability claims survived verification — the "fail-closed"/"encrypted"/"sandboxed" claims I spot-checked are all backed by real code.

## Critical assessment

### Critical

**C1. Literal NUL (0x00) bytes embedded in 6 production source files and 3 test files — the files are "binary" to git, grep, and ripgrep.**
Evidence (byte-verified with hexdump/python; `\x00` below is a raw NUL byte in the file, not an escape sequence):

- `src/core/cogsec/contact-block-list.ts:157` — `` return `${channelType}\x00${contactId}`; ``
- `src/faculties/wiki/shared-pgvector-projection.ts:309` — `` const key = `${row.scope}\x00${row.document_id}`; ``
- `src/system/config/fleet-auth-config.ts:624` — `` const identity = `${providerSubjectId}\x00${companionId}`; ``
- `src/core/agent/substrate-agent/turn-execution/prompt-cache-runtime.ts:65` — two NULs (join separator + `.join('\x00')`)
- `src/core/eval/observer-sidecar/persistence.ts:778` — `` `${databaseUrl}\x00${tenant.schema}` ``
- `src/boundary/fleet-auth/request-capability-target.ts:171` — regex char class `/[ -\x7f]/u` written with literal control bytes instead of `\x00`/`\x1f` escapes
- Test files (same pattern): `src/persistence/postgres.test.ts` (9 occurrences — partially deliberate NUL-injection tests), `src/core/agent/substrate-agent/participant-trend-runtime.test.ts:50`, `src/boundary/fleet-auth/escalation.test.ts:148`

Why it matters: any file containing a NUL is treated as binary by `git grep` (verified: `git grep fail-closed -- src/core/cogsec/contact-block-list.ts` returns nothing, exit 1, even though the phrase occurs in that file's comments), by ripgrep without `-a` (verified: "binary file matches"), and by `git diff` (renders "Binary files differ"). Two of the affected files are security-sensitive (`contact-block-list.ts` — cogsec block list; `fleet-auth-config.ts` — fleet auth identity composition). Agents and reviewers searching the tree silently miss content in these files. This is a classic AI-slop artifact: an LLM emits `\0` as a "safe" key separator and it materializes as a raw byte instead of the 6-character escape sequence.

The intent (NUL as an unambiguous composite-key separator) is legitimate and the runtime behavior is correct — the fix is purely source-level: write the separator as `'\0'`/`` escapes so the source file stays pure-UTF-8 text. In `postgres.test.ts` the raw-NUL payloads are the point of the test (NUL handling in Postgres params); those can use `String.fromCharCode(0)` or `` escapes with identical semantics.

How widespread: 9 files, 19 NUL bytes total, enumerated exhaustively by the byte scan above (the earlier "binary file matches" grep warnings correlate exactly).

### Major

**M1. Stale comment claims the auto-rollback target resolver is "currently unimplemented" — it is implemented and live-wired.**
`src/system/lifecycle/kube-auto-rollback.ts:292-294`:
```
// Target-revision safety invariant. `resolveRollbackTarget` is an injected
// (currently unimplemented) seam; the rollback surface must defend its own
// invariant rather than trust the target it is handed.
```
The seam IS implemented: `createLiveRollbackTargetResolver` at `src/app/operator/kube-self-update-transport.ts:189`, wired at `src/app/operator/kube-self-update-job-main.ts:277-281` and passed into the auto-rollback config at line 291. The defensive-invariant rationale in the comment is good and should stay; only the parenthetical is false. Recommended rewrite: drop "(currently unimplemented)" → "`resolveRollbackTarget` is an injected seam; the rollback surface must defend its own invariant rather than trust the target it is handed." Severity is major rather than minor because a reader maintaining this safety-critical rollback path is told the upstream doesn't exist — the opposite of the truth.

**M2. Three security-relevant TODOs reference a closed parent bead and a follow-up that does not exist in the tracker.**
All three are tagged `htm9.2-followup`:

- `src/core/session/manager-primitives.ts:1063-1067` — `wrapUntrustedContext` is a narrow opt-in; public-visibility context does not participate in the intake screening/decision surface.
- `src/core/agent/completion-handoff.ts:37-41` — subagent completion summaries fold back into the main agent with lifecycle audit but **no content-risk gate**.
- `src/faculties/shards/fold-review.ts:15-19` — fold review gates shard OUTPUT; nothing screens what the shard INGESTED.

Verification: parent bead `psfn-framework-htm9.2` is **closed** ("Implemented on feat/cogsec-intake-firewall (33 commits, validated)"). Its description explicitly listed items (4) public context wrappers, (5) subagent completion handoff, and (6) shard fold ingestion as in-scope — yet the code says they are not done. A `bd list` (all statuses) search for `shard_foldback` / `subagent_output` / `htm9.2-followup` finds **no bead** tracking the residue. So the parent was closed with scope items silently carried into in-code TODOs, and nothing in the tracker owns them. These are real, reachable security gaps (completion-handoff and fold-review are both wired into the live runtime), currently visible only to someone reading these exact files. This is comment debt that has become a tracking failure.

**M3. Staged privacy wiring promised to "a dependent bead" — no such bead exists.**
`src/faculties/memory/retrieval/access.ts:51-56`: `conversationScope` is plumbed into `RetrievalRoomVisibilityContext` but the comment says room-visibility gating "still derives from the loose fields above; a dependent bead flips the gate to consume the scope directly." Re-verified prior-audit finding PM-5: gating in `access.ts` still uses `currentIsDirectMessage`/`canonicalContactRoomIds` (read the file; `conversationScope` appears only at lines 51-57 as a carried field, never consumed in this file). `bd list` (all statuses) contains no bead mentioning a conversationScope gate flip. The comment is honest about the staging, but the tracking promise is false — this needs a bead or the comment rewritten to name the real owner. Candidate for the operator to decide: file the bead, don't just fix the comment.

### Minor

**m1. `docs/development-status.md` drift.** Dated 2026-07-12; the "Active Risks And Near-Term Work" table lists `PSFNLIVE-70nb` and `psfn-framework-zet.1` as P1 open needs — both are **closed** in the tracker (verified via `bd show`). The doc self-describes as "representative open beads", so a stale table actively misleads. Low effort: refresh or delete the table and point at `bd ready`.

**m2. `src/system/config/load-config.ts:626` "placeholder empty registry" comment is accurate but loose.** Verified: `bootstrap-helpers.ts:417` does overwrite `config.subagentRoles` from the owner file at startup, and bead 7ym.2.1 is closed. The comment tells the truth; "placeholder" is just imprecise wording for "default replaced at startup". Nit-level rewrite optional: "default empty registry; the real subagent-roles.json owner file is loaded and assigned during startup (bootstrap-helpers)".

**m3. `InMemoryRestWindowPolicy` is still the only production rest-window policy** (`src/app/agent/startup/free-time-lane.ts:142`), so prior-audit finding W2 (restart clears the welfare quiet window) still stands. The code comments admit durability was a non-goal for the originating bead. Not slop — an acknowledged trade-off — but it remains a welfare-relevant in-memory placeholder with no open bead found requesting a durable adapter. Candidate — needs human verification that this is still an accepted non-goal.

### Nits

- `src/app/e2e/e2e-walkthrough.ts` tells the companion "nothing is ever deleted... an unbreakable record of every conversation". Accurate for L0 sessions (append-only + integrity chain), slightly absolutist as demo copy. Harmless; leave it.
- `// ── Section ──` banner comments: 712 occurrences across 349 files. Consistent house style, not slop. No action.
- Empty constructors with parameter properties (`constructor(private readonly store: X) {}`) across `src/operator/garden/services/*` — idiomatic TS, not stubs. No action.

## Recommendations

Ordered by value; effort estimates assume familiarity with the repo's gates.

1. **Purge literal NUL bytes from the 9 files (safe mechanical change, ~30 min + focused tests).** Replace each raw 0x00 with the `` or `\0` escape sequence (identical runtime string), and `/[ -\x7f]/u` with `/[\x00-\x1f\x7f]/u` in `request-capability-target.ts`. In `postgres.test.ts` keep semantics with `` escapes. Consider adding a repository-hygiene check (fail on control bytes in `*.ts`) so this cannot recur — the pattern has clearly been introduced repeatedly by code generation. Verify after: `git grep` finds content in the previously-binary files.
2. **Fix the stale rollback comment** (`kube-auto-rollback.ts:293`, safe mechanical, 5 min): delete "(currently unimplemented) ". Keep the rest of the invariant rationale.
3. **File beads for the three `htm9.2-followup` security gaps** (design decision needed — this is real security wiring, not comment editing): subagent completion-summary screening (`completion-handoff.ts:37`), shard-ingest taint propagation (`fold-review.ts:15`), and public-context wrapper unification (`manager-primitives.ts:1063`). Then either keep the TODOs pointing at the new bead ids or, if the operator judges the gaps accepted-for-now, convert the TODOs into named-risk comments citing the bead. Effort: 30 min to file; implementation is its own scope.
4. **Resolve the conversationScope gate-flip promise** (`retrieval/access.ts:51-56`): file the dependent bead the comment claims exists, or rewrite the comment to state the loose-field gate is the current design with no flip planned. Filing the bead is the honest option given PM-5 flagged this as a privacy seam risk in July. 15 min to file; the flip itself is a design task.
5. **Refresh or truncate `docs/development-status.md`'s bead table** (safe mechanical, 15 min): remove the closed P1 rows or replace the table with a pointer to `bd ready --json` (the doc already says bd is authoritative).
6. **Decide on a durable `RestWindowPolicyPort`** (design decision): either file a bead for a Postgres-backed rest-window policy or record the in-memory choice as accepted in the bead notes so W2 stops resurfacing in audits.

## Risks & false positives

Deliberately NOT flagged, with verification:

- **`src/faculties/context-feedback/` (the assignment's "deferred Phase VI" candidate): intentional and exemplary.** The 9-line header at `runtime.ts:1-9` states it is "intentionally not composed into the runtime for bead psfn-framework-ls1k" and names the mandatory preconditions (config-owned deterministic gate: 1-in-N sampling, min response length, hash-keyed dedup). Verified: `wireContextFeedbackRuntime` is referenced only by its definition and tests; bead `ls1k` is closed with an explicit PARK decision recording exactly this. This is the correct way to park code — do not touch it.
- **`throw new Error('system.data.write owner is not implemented: ...')`** at `src/boundary/gateway/system-data-writer.ts:118` — exhaustiveness guard on `never`, the repo's fail-closed convention. Correct.
- **`role_gated` "reserved and not implemented"** at `src/system/trust/context-envelope.ts:236` — deliberate fail-closed rejection of a reserved mode, covered by tests. Correct.
- **`console.log` hits (549 total)**: all in CLI entrypoints (`src/app/cli/`, `src/app/e2e/`, `src/app/maintenance/*`) where stdout is the product. Zero debug leftovers in library paths. companion-ui/admin-ui have none.
- **"fail-closed" / "encrypted" / "sandboxed" / "tamper" claims**: spot-verified a sample — backup encryption is enforced fail-closed (`src/system/config/backup-config.ts:77-97` requires `encryption.mode === "required"`), the shell sandbox is real bwrap with PID-namespace teardown (`src/boundary/sandbox/execution/shell-execution-policy.ts`), the RLM sandbox is genuinely out-of-process (`src/core/tools/analysis-workbench/sandbox.ts:1-2,56`), tamper claims pair with digest/HMAC verification (`src/core/cogsec/forensic-archive.ts:160`, capsule custody parse-on-load). No larp found in the sample. Not exhaustive — other auditors should keep verifying claims they touch.
- **companion-ui sprite "placeholder art"** (`companion-ui/src/lib/sprites/*`): deliberately deterministic placeholder art with provenance flags (`placeholder: true` threaded through the manifest) and tests pinning the flags. Honest scaffolding, not slop.
- **CogSec corpus `known-gap` fixtures** (29 across 4 jsonl files, e.g. `evasions.jsonl:40`): known gaps carry `finding` text and open bead references (spot-checked `psfn-framework-tc6nk` — open, matching title). This is anti-larp: the coverage docs admit exactly what L1 misses.
- **"legacy" comments (~25 in `src/operator/garden/`, `src/faculties/wiki/`)**: these name versioned-handling paths (legacy Garden tokens, `legacy_unverified` artifact provenance, pre-plan prompt records) consistent with the migration-boundary rules in AGENTS.md. Not legacy-shim violations.
- **Bead-id references in comments (hundreds)**: provenance convention of this repo. Checked samples resolve to real beads. Keep them.

Candidates needing human verification:

- m3 (`InMemoryRestWindowPolicy` accepted non-goal?) — needs operator confirmation, not code reading.
- `docs/` beyond the spot-checked files — I verified `memory.md`, `development-status.md`, and L0/Postgres claims against code; the other ~30 docs were not audited and may carry similar drift.
- The NUL-byte fix is behavior-preserving by construction, but `prompt-cache-runtime.ts:65` feeds a cache key: confirm no persisted cache artifacts would be invalidated by re-encoding (they won't — the runtime string is identical — but a second pair of eyes on that one file is cheap insurance).

## Cross-lane notes

- **Dead code lane**: `src/faculties/context-feedback/` is 1,076 lines reachable only from tests — intentional park (ls1k), but knip-style tooling will flag it; treat as allowlisted, not dead.
- **Types/weak-types lane**: `src/faculties/context-feedback/runtime.ts:134` (`value as unknown as ContextManifest`) and `:160` (`JSON.parse(JSON.stringify(...))` clone) — fine in a parked module, worth a look if it is ever wired.
- **Defensive-code lane**: the NUL-separator composite keys (`contact-block-list.ts:157`, `fleet-auth-config.ts:624`, `observer-sidecar/persistence.ts:778`, `shared-pgvector-projection.ts:309`) assume the joined components can never contain NUL; that invariant is undocumented. After re-encoding to escapes, a one-line comment per site would help.
- **Legacy lane**: `src/app/startup/index.ts` is a disabled entrypoint that exits fail-closed with an error message — verified accurate and matches `docs/development-status.md`. Leave it.
- **Docs lane** (if any): `docs/development-status.md` closed-bead drift (m1) is the only confirmed docs drift; full docs audit out of my scope.
- **Cycles/dedup lanes**: nothing found in my sweeps that belongs there.
