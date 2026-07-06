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

One command does the whole loop (build → in-image verify → ship → skew-aware
helm upgrade → gate):

```bash
npm run ship:kube -- --components agent    # companion-core-only: gateway/garden stay up
npm run ship:kube -- --components all      # full stack (required when the contract hash changed)
npm run ship:kube -- --components all --values-overlay <file>  # config enablement rides the same upgrade
```

Every ship also refreshes the companion's source checkout (git bundle →
`/mnt/psfn-nvme/psfn-source`) and round-trips beads
(`scripts/ops/sync-companion-beads.sh`, bd export/import upsert both ways) —
her self-view is exactly as fresh as her runtime. Target selection:
`--host <alias>` / `PSFN_HOST_ALIAS` + `PSFN_NAMESPACE` for non-default
deployments (e.g. Carlini). The skew guard is live-proven: a boundary/contract
change on a selective ship fails closed naming the component that would skew.

Selective rollouts are contract-hash guarded: the image bakes a hash of
`src/shared/contracts` + `src/boundary` into `/app/contract-hash.txt`; the
ship fails closed when a partial rollout would split the agent↔gateway
contract, and the validation gate independently checks live components agree.
Agent-only ships avoid the gateway restart entirely (no RPC drop, one
"I'm back" instead of 2-3). All three app deployments use strategy Recreate —
the agent too, to guarantee a single live instance.

The observer-eval engine is its own component and image:

```bash
npm run ship:kube -- --components emosim   # emo_sim engine only (app pods untouched)
```

It builds `localhost/psfn-emosim` from `docker/Dockerfile.emosim` with a
clean `~/emo_sim` checkout (`PSFN_EMOSIM_SRC` to override) as the build
context, tagged by the emo_sim commit. It is pure Python with no TS contract
surface, so it sits outside the contract-hash guard (`--components all` does
NOT include it); its runtime contract (17 appraisal dims / 48 emotions) is
verified in-image at build time and by the gate's optional emosim check.
The first emosim ship persists `emosim.enabled=true` into the release values,
so subsequent app-only ships keep the deployment. The sidecar consumes it via
`settings.json` `observerEvalSidecar.adapter` (kind `emosim_server`,
`serverUrl` `http://psfn-emosim:17342`).

Manual procedure, if the script cannot be used
(emulated arm64 off-node; on-Pi builds starve the runtime):

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
# NEVER --reuse-values with a changed chart (nil-pointers on new keys):
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm get values psfn -n psfn -o yaml > live-values.yaml
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm upgrade psfn <chartdir> -n psfn \
  -f live-values.yaml \
  --set psfnAppImage.tag=0.1.0-kube-<shortsha> \
  --set psfnAppImage.gitCommit=<fullsha> \
  --set psfnAppImage.previousGitCommit=<prev-deployed-sha>
```

Per-component tags: `--set workloads.<agent|gateway|garden>.image.tag=<tag>`
(empty string = follow the shared `psfnAppImage.tag`).

`gitCommit`/`previousGitCommit` feed the companion's `diagnose` "fixes shipped
in this build" line — always set them. Gateway/garden use strategy Recreate
(brief downtime instead of the old hostPort deadlock). The agent restarts 2×
per swap by design (RPC loss) — not a failure signal.

## 3b. Shipping to a NEW target (Carlini or any second deployment)

One-time migrations the first ship to a target must handle — all hit live on
psfn-shard 2026-07-06:

1. **Strategy SSA conflict**: live deployments created under RollingUpdate
   reject the chart's `Recreate` ("spec.strategy.rollingUpdate: Forbidden").
   Pre-patch each app deployment once:
   `kubectl -n <ns> patch deploy <d> --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'`
2. **ConfigMap ownership**: anything ever `kubectl replace`d (e.g. litellm
   config hotfixes) conflicts with helm server-side apply. Make the CHART own
   the content first (else the upgrade reverts the hotfix!), then
   `kubectl delete configmap <name>` immediately before the upgrade so helm
   re-creates and owns it.
3. **First selective ship is impossible**: live images predate the contract
   hash → the guard demands `--components all` once. Correct; do it.
4. **LiteLLM routes**: the `openrouter/*` wildcard does NOT match PSFN's
   unprefixed model names — every models.json slot needs an explicit route in
   the chart's litellm config (values.yaml `liteLlm.config.yaml`) or all
   traffic silently falls back to direct OpenRouter.
5. **Companion self-management enablement** (values overlay, see
   `repositoryCheckout` + `beads` values): source checkout arrives via git
   bundle (`git bundle create` → clone on host → `chown -R 999:999` +
   host `git config --system --add safe.directory <path>`); beads needs a
   one-time in-pod `bd init --prefix <prefix>` + `bd import <shared-export>`
   in `/app/workspace` (DOLT_ROOT_PATH is chart-provided; bd's embedded dolt
   works on arm64) and `bd metrics off`. Keep `close`/`sync` out of
   BEADS_ALLOW_ACTIONS until approval flows exist.
6. **Companion skills** install to `<workspace>/skills/<name>/SKILL.md`
   (the runtime's managed root; frontmatter needs name + description),
   `chown -R 999:999`. **No restart needed** — the skills faculty rescans at
   use time (live-verified 2026-07-06: file drop → visible in her next skill
   scan, pods untouched). `.agents/skills/` is the coding-agent convention
   dir — the runtime does NOT read it.
7. **Off-node backups**: install/point `/usr/local/bin/psfn-backup.sh` at the
   target's live cluster + its NFS share. The pre-cutover trap to never
   repeat: a timer that keeps dumping a frozen/stale DB looks healthy while
   backing up nothing — the script must `pg_restore --list` its own dump and
   fail the unit otherwise. NFS root-squash needs `tar --no-same-owner`.

## 4. Validate — the gate is not optional

```bash
npm run verify:kube-rollout -- --remote --expect-tag 0.1.0-kube-<shortsha> --smoke
```

Always pass `--remote` (a local kubectl for another cluster hijacks auto
mode). `--expect-tag` must match the commit actually SHIPPED, not HEAD.
The smoke can race the agent's by-design second restart right after a
full-stack rollout — wait ~90s and rerun before believing a 503. The gate
includes contract-hash consistency across live pods and auto-detects
optional services (emosim).

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
- Beads data: NEVER `bd prune` a parent whose children survive — orphaned
  children FK-break every export/import round-trip (restore a placeholder
  parent with the original ID to repair, cf. psfn-framework-1z6).
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
