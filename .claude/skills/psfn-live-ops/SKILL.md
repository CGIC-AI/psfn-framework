---
name: psfn-live-ops
description: Investigate, repair, and redeploy the live PSFN companion on psfn-shard (k3s). Use when diagnosing live behavior bugs (repetition, missing replies, tool failures), shipping a fix to the Pi, cleaning polluted runtime data, or validating a rollout. Covers evidence gathering, the build/deploy contract, the validation gate, and the data-surgery rules.
---

# PSFN Live Ops — investigate, repair, redeploy

Runbook for working on the **live** Purrsephone deployment (k3s on `psfn-shard`,
namespace `psfn`, SSH alias `psfn-pi`). Grown out of the 2026-07-06 repetition
incident and the x5rt self-management epic. Companion-data is sacrosanct:
backup before any mutation, never `rm -rf` near backups, and treat her state
(memories, concerns, follow-ups) as hers — cleanup of companion state is an
operator decision, not yours.

## 1. Investigate — evidence before theory

Work from live evidence, not code reading alone. The order that works:

1. **Deployed identity first**: `kubectl -n psfn get deploy -o jsonpath=...image`
   and `helm history psfn -n psfn`. Compare against `git log` — know exactly
   which commits are running before reasoning about behavior. (A "fixed" bug
   that still reproduces usually means the fix isn't deployed — or the fix was
   for a different mechanism.)
2. **Session truth**: the Postgres projection (`session_messages_projection`)
   for quick queries; the JSONL session stores
   (`/app/companion-data/state/sessions/`) are the runtime's source of truth.
   If they disagree, that IS the finding.
3. **Turn records are the decisive artifact**:
   `/app/companion-data/state/sessions/_turn_records/<channel>.jsonl` — each
   line contains `observability.snapshot` with `sessionContext.recentEntries`
   (the selected window), `plan.messages` (the actual wire prompt), and
   `promptContext.finalSystemSections`. **What the model actually saw settles
   arguments that logs and transcripts cannot.** Pull the relevant lines with
   `kubectl exec ... tail`; they are large — extract locally with python.
4. **Model routing**: `model_usage_events` — always check
   `requested_provider` vs `provider`. A silent fallback ran for 3 days once.
5. **Agent logs**: `kubectl -n psfn logs deploy/psfn-agent --since=...` — grep
   WARN/ERROR. Every-turn WARNs are load-bearing clues, not noise.
6. **Companion self-surfaces** (post-x5rt): `self_status` actions `diagnose`
   (deployment identity + fixes shipped + routing health), `logs` (redacted
   diagnostics), `conformance` (tool-surface sweep). Admin equivalents:
   `GET /api/admin/diagnostics`, `POST /api/admin/tool-conformance/run`.

Subagent split that works: Fable/deep-reasoner agents in **worktrees branched
from the working branch** (`git checkout -b <x> foundation_e0_e2` first —
never main unless main is the target) for root-cause and design-sensitive
work; Codex (`codex-companion.mjs task --background --write --effort xhigh`,
default model) for mechanical, file-scoped work in the main checkout with
explicitly disjoint file sets. Codex cannot SSH — live evidence must be
fetched by the orchestrator and staged into the scratchpad.

## 2. Repair — repo rules that bite

- Fail closed; no swallowed errors; no silent fallbacks. Warn-and-continue
  catches around context assembly have caused real incidents.
- **Internal bookkeeping never enters session transcripts.** If the companion
  needs a completion signal it is ≤2 lines, rendered once, positioned in the
  system prompt above the chat tail (`CompletionNoticeBuffer` /
  `background_completions` block). See commit e22c1653.
- Intention/concern items surface when due, not always-in-context; dedupe at
  enqueue (commit 88ec761e).
- Diagnostics/conformance surfaces return tool results only — never write
  observations into conversational sessions (the 2026-07-06 regression).
- `src/core/agent/substrate-agent.ts` has a non-UTF8 byte: use `git grep` or
  `grep -a`.
- `@mariozechner/pi-ai` is **pinned** and patched via `patch-package`
  (`patches/`); `patch-package` must stay in `dependencies` (production
  `npm ci --omit=dev` runs postinstall). A pi-ai version bump requires
  regenerating the patch.
- Baseline test failures exist; before blaming your change, run the failing
  file against a pristine worktree of the base commit.

## 3. Build & deploy contract

Build off-node (emulated arm64; on-Pi builds starve the runtime):

```bash
git archive HEAD | tar -x -C <builddir>
docker buildx build --platform linux/arm64 -f docker/Dockerfile.agent \
  -t psfn-framework:0.1.0-kube-<shortsha> --load <builddir>
docker save ... | gzip → scp → psfn-pi:~/psfn-kube-runtime/
ssh psfn-pi "gunzip ... && sudo k3s ctr images import <tar>"
# ctr imports as docker.io/library/<name> — MUST re-tag:
sudo k3s ctr images tag docker.io/library/psfn-framework:<tag> localhost/psfn-framework:<tag>
```

Deploy with the chart **from the same commit** (copy it over if it changed):

```bash
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm upgrade psfn <chartdir> -n psfn \
  --reuse-values \
  --set psfnAppImage.tag=0.1.0-kube-<shortsha> \
  --set psfnAppImage.gitCommit=<fullsha> \
  --set psfnAppImage.previousGitCommit=<prev-deployed-sha>
```

`gitCommit`/`previousGitCommit` feed the companion's `diagnose` "fixes shipped
in this build" line — always set them. Gateway/garden use strategy Recreate
(brief downtime instead of the old hostPort deadlock). The agent restarts 2×
per swap by design (RPC loss) — not a failure signal.

## 4. Validate — the gate is not optional

```bash
npm run verify:kube-rollout -- --expect-tag 0.1.0-kube-<shortsha> --smoke
```

(`scripts/ops/validate-kube-rollout.sh`; runs remote over SSH when kubectl is
not local.) It encodes: rollout status ×3, pod/image checks, Garden health,
`/v1/models`, pgvector, Redis, bounded log scan, **requested-vs-served
provider**, **zero bookkeeping rows in session stores**, and a two-turn
continuity smoke. For context-assembly changes, additionally pull the smoke
turn's turn record and confirm `plan.messages` is exactly real dialogue.
After a maintenance-timer cycle (~30–45 min), re-verify no unexpected session
writes appeared on any channel.

## 5. Data surgery (when runtime data itself is polluted)

- Scale the agent to 0 first; the gateway can stay up.
- Backup trio before touching anything: tar of the affected state dirs,
  `pg_dump` of affected tables, and a JSONL export of every row you remove.
- PVC files belong to **uid 999 gid 999, mode 0664** (container user, NOT the
  host `psfn` user). A root-owned rewrite bricks turns with EACCES.
- Rewrite JSONL atomically (tmp file + rename); refuse to rewrite any file
  with an unparseable line.
- Postgres projection cleanup goes through `kubectl exec -i psfn-postgres-0 --
  psql` with the SQL piped on stdin (inline quoting through ssh+kubectl+psql
  is a tarpit).
- LiteLLM: the in-cluster proxy needs **explicit unprefixed model routes**
  (`z-ai/glm-5.2` → `openrouter/z-ai/glm-5.2`); the `openrouter/*` wildcard
  alone does NOT match PSFN's unprefixed requests and everything silently
  falls back to direct OpenRouter. New models.json slots need a matching
  ConfigMap entry + litellm rollout restart.

## 6. Close the loop

- `bd` comments with evidence at each phase; close beads only after live
  validation, then `bd dolt push`, `git push` (work is not done until push
  succeeds).
- Update the operator memory note for anything the next session must know
  (deployed rev, config backups, new traps).
- Tell the companion what shipped: her `diagnose` action reports it, and
  unresolved concerns about already-fixed bugs should be closable by her once
  she can see the fix provenance.
