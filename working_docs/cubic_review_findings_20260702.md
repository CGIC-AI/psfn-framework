# Cubic Review Findings Summary - 2026-07-02

## Scope

This summarizes the Cubic review pass for the under-200-file split PR stack that superseded the original `foundation_e0_e2` into `main` PR.

- Original PR: `#15`
- Split review PRs: `#16` through `#28`
- Validation target: final `foundation_e0_e2` branch tip, not only intermediate split heads
- Tracker: `bd`
- Code changes made in this pass: none

## Bead Epics

- P1 epic: `psfn-framework-mlwk` - `Epic: Cubic review P1 validated findings`
- P2 epic: `psfn-framework-qs83` - `Epic: Cubic review P2 validated findings`

Child beads created:

- P1: `49` child beads, `psfn-framework-mlwk.1` through `psfn-framework-mlwk.49`
- P2: `165` child beads, `psfn-framework-qs83.1` through `psfn-framework-qs83.165`

Each child bead includes:

- Cubic severity
- Split PR number
- GitHub review-thread URL
- Cited file and line
- Final-tip validation evidence
- Fix scope and non-goals
- Regression test and validation expectations
- Mandatory `npm run lint` before closure when code changes

## P1 Result

Input P1 threads: `59`

- Valid actionable P1 defects beaded: `49`
- Obsolete or already resolved at final tip: `4`
- Duplicate root causes collapsed: `1`
- Real but downgraded below P1: `5`

P1 themes:

- Request cancellation and runtime shutdown semantics
- Backup, restore, archive, and path-containment safety
- Memory/episodic atomicity and watermark consistency
- Prompt/CogSec/forensic integrity
- Admin and companion UI stale-state bugs
- Kubernetes/Helm deployment safety
- Social graph cursor correctness

P1 findings intentionally not beaded as P1:

- Obsolete/resolved:
  - `eval/llm-response/redaction.ts:20` - old eval tree removed later in stack
  - `eval/companion-shape/qao-judge-run.ts:167` - old eval tree removed later in stack
  - `src/core/scheduler/heartbeat-template-runtime.ts:486` - sparse variable `.trim()` crash fixed at final tip
  - `src/core/agent/substrate-agent/runtime-context.ts:219` - substrate health prompt block removed at final tip
- Duplicate collapsed:
  - `src/operator/garden/services/memory-body-gate.ts:1` duplicated the `AdminMemoryBodyGate` shared grant defect beaded as `psfn-framework-mlwk.43`
- Downgraded below P1:
  - `src/core/tools/analysis-workbench/prompt.ts:120` - prompt example typo
  - `src/faculties/memory/extraction/orchestrator.test.ts:257` - test assertion mismatch
  - `src/channels/api/server/request.ts:147` - privacy validation message drift
  - `src/channels/backplane/satellite-registry.ts:176` - privacy validation message drift
  - `admin-ui/src/lib/api/endpoints/channels.ts:29` - frontend display/type mismatch

## P2 Result

Input P2 threads: `191`

- Valid actionable P2 defects beaded: `165`
- Obsolete or already resolved at final tip: `16`
- Duplicate root causes collapsed: `5`
- Real but downgraded below P2: `5`

P2 themes:

- Config validation and admin route error semantics
- Prompt macro/runtime cache correctness
- Garden UI async stale-response races
- Memory retrieval, extraction, retention, and migration edge cases
- CogSec remediation and forensic metadata consistency
- Kubernetes/Helm chart correctness
- Wiki projection, retrieval, and sleeptime-pass scaling
- Scheduler, wakeup, free-time, and outreach edge cases

P2 obsolete/resolved findings:

- `#16 src/operator/garden/services/episodic-memory-service.ts:327` - thread arc lookup batching already present
- `#16 eval/memory/run.ts:108` - deleted eval CLI
- `#16 eval/memory/provider.ts:188` - deleted eval provider
- `#16 eval/memory/provider.ts:173` - deleted eval provider
- `#16 eval/discovery/openrouter-logprob-discovery.ts:403` - deleted eval probe
- `#16 eval/discovery/openrouter-logprob-discovery.ts:544` - deleted eval probe
- `#16 src/faculties/memory/active-context.ts:94` - final cache key includes session channel
- `#17 src/core/identity/runtime-prompt-layers.ts:561` - final migration no longer depends on stale legacy literal
- `#18 eval/companion-shape/regression.ts:320` - deleted eval tree
- `#18 eval/companion-shape/qao-judge.ts:387` - deleted eval tree
- `#18 eval/emotion-l3/types.ts:73` - deleted eval tree
- `#18 eval/llm-response/providers.ts:61` - deleted eval tree
- `#18 eval/emotion-l3/benchmark.ts:229` - deleted eval tree
- `#18 eval/emotion-l3/benchmark.ts:46` - deleted eval tree
- `#18 eval/companion-shape/qao-corpus.ts:259` - deleted eval tree
- `#20 src/core/agent/fatigue/fatigue-budget.ts:323` - final code strips `channelId` from correlation metadata

P2 duplicate findings:

- `#26 src/core/cogsec/events.ts:504` duplicated `parseConformanceCheck.reasonCodes`
- `#26 src/core/identity/prompt-macro-audit.ts:47` duplicated conditional macro audit coverage
- `#26 src/faculties/core-memory/scope-audit.ts:74` duplicated malformed `scopes` audit coverage
- `#26 src/core/identity/prompt-runtime.ts:575` duplicated conditional volatile macro coverage
- `#27 src/channels/api/agent-backend.ts:667` duplicated the same agent-backend privacy message finding

P2 downgraded findings:

- `#19 deploy/helm/psfn/templates/redis.yaml:9` - Redis StatefulSet headless service convention gap, but no confirmed P2 runtime break in single-replica chart use
- `#21 src/shared/resilience/circuit-breaker.ts:143` - empty-string reset API inconsistency, but generated circuit keys are non-empty
- `#21 src/faculties/memory/extraction/group-classifier.ts:501` - serialized contact lookups are a bounded optimization issue
- `#26 CLAUDE.md:289` - documentation-only undefined "Opus" reference
- `#28 src/core/session/manager.ts:1258` - maintainability duplication, not a behavioral P2 failure

## Notes

- The P2 validation was split across subagents by PR range and then aggregated into one validation set.
- Findings whose files were removed later in the stack were marked obsolete unless the same behavior moved elsewhere and still reproduced.
- Duplicate review comments were collapsed into a single bead only when they shared the same underlying defect.
- No GitHub review threads were resolved in this pass.
