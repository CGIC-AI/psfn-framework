# Audit Lane 4 — Circular Dependencies & Layering

Date: 2026-08-05. Branch audited: `feat/emosim-fleet-shakedown` (working tree as-is). Read-only audit; no files modified except this report.

## Scope & method

**Tooling read in full:**

- `scripts/lib/import-graph.ts` (218 lines) — graph builder: AST-based specifier extraction (static `import`/`export … from`, `import =`, and single-argument dynamic `import()`), extension resolution, transitive-dependents and seam-matching helpers.
- `scripts/lib/import-graph.test.ts` — unit tests for the helpers.
- `scripts/check-dependency-cycles.ts` (248 lines) — the gate behind `npm run verify:dependency-cycles` (wired into `verify:repository-hygiene`, `package.json:129,138`). DFS back-edge cycle detection with rotation/reversal-canonicalized cycle keys, compared against a JSON baseline.
- `scripts/report-import-graph-impact.ts` (226 lines) — informational transitive-dependents reporter for registered seams, invoked from `.github/workflows/ci.yml:81` (not from `package.json`).
- `config/dependency-cycle-baseline.json`, `config/import-graph-seams.json`.
- Prior audits `working_docs/READONLY_AUDIT_*_20260721.md` were checked for cycle claims; none conflicted with current findings.

**Commands run (all read-only):**

1. `npm run verify:dependency-cycles` — production `src/` graph: **1861 files, 10239 edges, 0 cycles detected**.
2. `npx tsx scripts/check-dependency-cycles.ts --include-tests` — with test files: **3135 files, 15454 edges, 0 cycles detected**.
3. Independent verification: rebuilt the graph via `scripts/lib/import-graph.js` from an inline `tsx -e` script and ran an **iterative Tarjan SCC** over it (independent algorithm, recursion-safe). Result: **0 SCCs of size > 1, 0 self-loops** in `src/`. The gate's "no cycles" verdict is confirmed, not just trusted.
4. Same Tarjan pass over other roots: `companion-ui/src` (75 files) **0 SCCs**; `admin-ui/src` (196 files) **0 SCCs**; `scripts/` (54 files) **0 SCCs**; `PSFN-Satellite-Hub` (69 files) **1 SCC of size 2** (details below).
5. Layer-matrix analysis: collapsed the `src/` file graph to top-level directories (`app, boundary, channels, core, faculties, operator, persistence, primitives, shared, system, test-support`) and counted all cross-layer edges (5564 total), then inspected every "upward" edge of interest at `path:line` level, classifying each as **value import vs `import type`** by reading the actual import statements.
6. Group-level (two-directory) condensation to find module-cluster mutual dependencies.
7. Resolver-correctness probe: re-derived every relative specifier in `src/` and checked whether any import whose target file exists was dropped from the graph (see "Tool correctness" below).
8. `bd show PSFN-7hue --json` (read-only) and `git log --oneline -- config/dependency-cycle-baseline.json` for baseline history.

**Coverage limits:** the in-repo graph only covers relative specifiers between `.ts/.tsx/.mts/.cts` files; path-alias imports (if any) are invisible to it. `admin-ui` Svelte `<script>` imports inside `.svelte` files are not scanned (only `.ts` files). External-package cycles are out of scope. The `--include-tests` run doubles the graph; the gate runs without it, so test-only cycles would not fail CI (none exist anyway).

## Critical assessment

### Headline: zero file-level import cycles anywhere

There are **no circular import chains** in `src/` (production or tests), `companion-ui/src`, `admin-ui/src`, or `scripts/`. The one SCC found anywhere is in `PSFN-Satellite-Hub` and is half type-only (below). The real findings are (a) a fully stale baseline, (b) value-level layering inversions that are one import away from becoming cycles, and (c) latent tooling weaknesses.

---

### MAJOR 1 — The dependency-cycle baseline is 100% stale; the gate currently guards nothing

Evidence: `npm run verify:dependency-cycles` output (run 2026-08-05):

```
Baseline-matched cycles (0).
Baseline entries not currently detected (4) — consider pruning baseline after PSFN-7hue work lands:
- boundary/sandbox/capabilities/contracts.ts -> core/tools/analysis-workbench/types.ts
- core/agent/active-emanation-state.ts -> core/agent/presence-metadata.ts
- core/session/context-manifest.ts -> faculties/memory/withheld-summary.ts -> system/trust/policy.ts -> shared/contracts/runtime.ts
- faculties/shards/manager.ts -> faculties/shards/port.ts
No circular imports detected.
```

- All 4 entries in `config/dependency-cycle-baseline.json:4-9` correspond to cycles that **no longer exist**. E.g. `src/core/agent/presence-metadata.ts:4` imports from `./active-emanation-state.js` but the reverse edge is gone — consistent with remediation commit `2cfb7e99d chore(session): untangle type-only manager import cycle (vl6q)`.
- The baseline's `remediationTracker` (`config/dependency-cycle-baseline.json:3`) is bead **PSFN-7hue, which is closed** (`bd show` → `status: closed`). The same closed bead is hardcoded in the checker itself at `scripts/check-dependency-cycles.ts:15-16`, obfuscated as `['P','S','F','N'].join('') + '-7hue'` (apparently to dodge the identity-literal scan — a smell worth removing).
- The bead's own description references a `.mjs` checker (`scripts/check-dependency-cycles.mjs`) and cycle paths from a pre-charter-migration layout — it describes a different generation of the tool entirely.

Why it matters: the gate still *functions* (any genuinely new cycle is a regression and fails), so this is not a silent-pass bug. But the stale baseline misleads every reader into believing four grandfathered cycles exist, and the repo's own convention (the checker prints "consider pruning") is being ignored. It also means nobody has verified the "baseline entries only shrink" discipline.

### MAJOR 2 — `src/persistence/postgres/fleet-auth/` is a layering inversion cluster: persistence value-imports the gateway/boundary (46 edges, 23 files), centered on a composition root living in the wrong layer

`persistence/` → `boundary/` runtime edges: **46 edges from 23 files**; the reverse direction `boundary/` → `persistence/` has 25 edges. The cluster is mutually dependent at the module level and is kept acyclic only by careful per-file discipline — exactly the condition that produces surprise cycles.

The keystone is `src/persistence/postgres/fleet-auth/gateway-persistence.ts`, which is **composition wiring, not persistence**. Its import block (lines 1–80+) value-constructs gateway and boundary services:

- `src/persistence/postgres/fleet-auth/gateway-persistence.ts:4` — `import { GatewayFleetAuthBroker } from '../../../boundary/gateway/fleet-auth-broker.js'`
- `:44` — `import { DiscordEvidenceRuntime } from '../../../boundary/fleet-auth/discord-evidence-runtime.js'`
- `:47` — `import { DiscordEvidenceLifecycleCoordinator } from '../../../boundary/fleet-auth/discord-evidence-lifecycle.js'`
- `:64` — `import { GatewayFleetAuthChildAssertionBroker } from '../../../boundary/gateway/fleet-auth-child-assertions.js'`
- `:68` — `import { FleetEscalationCoordinator } from '../../../boundary/fleet-auth/escalation.js'`
- `:72` — `import { GatewayTrustedHostGardenRecoveryService } from '../../../boundary/gateway/trusted-host-garden-recovery.js'`
- plus `verifyAndConsumeHubDeviceAssertion` (`:39-43`), `createGatewayRequestCapabilitySigner/createRequestCapabilityVerifier` (`:60-65`), `GatewayFleetAuthLifecycleCeremonyService` (`:74-78`), and ~15 type-only port imports from `boundary/`.

Other value-level examples in the same cluster:

- `src/persistence/postgres/fleet-auth/authorization-context.ts:2` — `import { GatewayFleetAuthorizationContextResolver } from '../../../boundary/gateway/fleet-authorization-context.js'`
- `src/persistence/postgres/fleet-auth/child-assertion-authority.ts:14` — `import { fleetAuthRoleAllowsAction } from '../../../boundary/fleet-auth/role-action-policy.js'`
- `src/persistence/postgres/fleet-auth/portal-authorization-store.ts:16` — same role-policy value import
- `src/persistence/postgres/fleet-auth/oauth-secret-codec.ts:8` — `import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js'`
- `src/persistence/journals/hmac-boundary.ts:1-2` — type + value import from `boundary/custody/credential-vault.js`

Why it matters: the fleet-auth subdomain has its "ports" defined in `boundary/` and its adapters in `persistence/`, but one file then wires them together inside `persistence/`. Any future import from `boundary/gateway/*` back into a `persistence/` file that gateway-persistence transitively reaches creates an instant cycle. This is also the cluster most likely to produce the next baseline entry.

### MAJOR 3 — `boundary/` and `channels/` value-import the composition layer `src/app/startup/` (9 edges), inverting the composition-root rule

`src/app/` is the top of the tree (composition roots per `docs/architecture.md:55-62`); nothing beneath it should import it. Violations, verified value imports:

- `src/boundary/gateway/channel-surfaces.ts:20-25` — value imports `createDiscordChannelAdapterFactoryEntry, createTelegramChannelAdapterFactoryEntry, getOptionalChannelAdapter, requireChannelAdapter` from `../../app/startup/composition/channel-runtime.js`
- `src/boundary/gateway/channel-surfaces.ts:26-30` — value imports `buildChannelAdapterFactoryManifest, loadChannelAdaptersFromManifest` from `../../app/startup/support/channel-lifecycle.js`
- `src/channels/api/voice-websocket-runtime.ts:22-26` — value imports `createRuntimeVoiceSttConnector, createRuntimeVoiceTtsConnector, resolveRuntimeVoiceProviderGate` from `../../app/startup/support/bootstrap-helpers.js`
- `src/channels/discord/voice-preflight.ts:6-7` — value import `resolveRuntimeVoiceTtsProviderOrder` from the same
- `src/channels/discord/voice.ts:32-33` — value import `resolveRuntimeVoiceTtsProvider` from the same

Type-only (benign at runtime, still upward at type level): `src/boundary/gateway/bootstrap-input.ts:36-37`, `src/boundary/gateway/privileged-core.ts:28`, `src/channels/discord/voice-types.ts:5`, `src/operator/garden/operator-surface.ts:33`.

Why it matters: `app/startup/support/bootstrap-helpers.ts` and `app/startup/composition/channel-runtime.ts` are de facto shared runtime libraries that happen to live in the composition layer. This works only while `app/` never imports these boundary/channels files back along the same paths (currently `app` → `boundary` = 105 edges, `app` → `channels` exists too). These 9 edges are the shortest paths to a future cycle and they muddy the "composition root owns wiring" contract in `docs/architecture.md`.

### MINOR 1 — `src/shared/` has 5 runtime-value upward edges (and 12 type-only ones), contradicting "shared is the bottom layer"

`docs/architecture.md:13` states cert-manager "shares only `src/shared/` with the runtime", which requires `shared/` to be dependency-free upward. Value violations:

- `src/shared/cache/redis-cache.ts:3` — `import { RUNTIME_LAYOUT_MODE, resolveRuntimeLayoutMode } from '../../persistence/layout.js'`
- `src/shared/telemetry/charge-ledger.ts:4` — `import { appendJsonLine } from '../../persistence/jsonl.js'`
- `src/shared/telemetry/fatigue-ledger.ts:4` — `import { appendJsonLine } from '../../persistence/jsonl.js'`
- `src/shared/telemetry/run-charge.ts:10` — `import { getRequestContext } from '../../primitives/llm/request-context.js'`
- `src/shared/contracts/artifact-sensitivity.ts:2-6` — value import `SENSITIVITY_LEVELS, sensitivityOrd` from `../../system/trust/types.js`

Type-only upward: `src/shared/event-bus.ts:15-44` imports **10 `core/` modules** (`core/turns/snapshot`, `core/session/session-routes`, `core/agent/adaptive-tools-telemetry`, `core/agent/fatigue/*` ×3, `core/agent/arbiter/*` ×3, `core/participation/types`) — all `import type`, plus `src/shared/contracts/satellite-registry.ts:1` (`import type { ChannelPrivacy }` from `system/trust/context-envelope`). Type-only edges are erased at runtime, but they mean `shared/` cannot be typechecked or packaged standalone, and `event-bus.ts`'s event map is coupled to `core/agent` internals. (Also note `event-bus.ts` is 1623 lines — see cross-lane notes.)

### MINOR 2 — `system/` value-imports `core/` and `boundary/gateway/` (policy layer reaching sideways/up)

- `src/system/capabilities/gate.ts:9-12` — value import `buildRedactedPreToolAudit` from `../../boundary/gateway/pre-tool-hook.js`
- `src/system/capabilities/compositional-policy.ts:2` — value import `inferSessionChannelType` from `../../core/session/session-id.js`
- `src/system/config/load-config.ts:46` — value import from `../../core/identity/companion-naming.js`
- `src/system/config/icp-autonomy-scheduler-config.ts:1` — value import `MAX_ICP_CANDIDATE_TTL_MS` from `../../core/icp/initiation-candidate.js`

(`system` → `boundary/pi-agent` edges such as `gate.ts:2` are **not** flagged: `src/boundary/pi-agent/index.ts:1-19` documents itself as the sole sanctioned wrapper around `@mariozechner/pi-agent-core`; it is a vendored-primitive facade that merely lives under the `boundary/` name.)

Also in this class: `src/faculties/wiki/places-wiki-publication.ts:20` and `src/faculties/wiki/runtime-wiring.ts:27` value-import `channels/backplane/places-registry.js` (faculties → channels), and `src/system/config/*` value-imports `channels/backplane/config.js` (3 edges).

### MINOR 3 — Module-cluster mutual dependency is widespread (100 two-directory group pairs), sustained only by per-file acyclicity

Collapsing the file graph to two-level directories yields **100 mutually-dependent group pairs**. The most connected hubs:

- `core/agent` is mutually dependent with **24** sibling groups (core/session, core/cogsec, faculties/memory, system/config, boundary/gateway, persistence/sessions, primitives/llm, …)
- `boundary/gateway` with **13** groups (channels/api, channels/discord, core/agent, faculties/memory, persistence/postgres, system/config, …)
- `app/startup` ↔ `boundary/gateway`, `app/startup` ↔ `channels/api`, `app/startup` ↔ `channels/discord`, `app/startup` ↔ `operator/garden` (echoes Major 3)
- `boundary/fleet-auth` ↔ `persistence/postgres`, `boundary/fleet-auth` ↔ `system/config` (echoes Major 2)

This is not a gate failure — the file-level DAG is acyclic — but it quantifies how little structural protection exists between clusters: cycle-freedom currently depends on discipline within heavily interconnected clusters rather than on enforced layer boundaries. `core/agent` and `boundary/gateway` also contain the repo's largest files (see cross-lane notes), so cluster coupling and god files reinforce each other.

### MINOR 4 — Tooling weaknesses in the cycle gate itself (latent, not currently causing wrong verdicts)

1. **Resolver drops edges instead of probing candidates by existence.** `scripts/lib/import-graph.ts:139-149` (`resolveImportToSource`) returns the *first* candidate that is merely inside the source root, without checking that the file exists; `buildImportGraph` then silently drops the edge if that candidate isn't in the file set. So `import './foo.js'` where `foo.ts` is absent but `foo.tsx` exists resolves to the non-existent `foo.ts` and the edge vanishes. I probed the whole `src/` tree: **zero genuinely dropped edges today** (the only pseudo-case is a `.json` import in `src/primitives/images/model-catalog.ts`, which is correctly not a source edge). Latent false-negative — would hide a real cycle if the repo ever gains `.tsx`/`.mts` files or mixed-basename layouts. `companion-ui` *does* use `.tsx`, so the tool cannot be safely reused there as-is.
2. **Type-only and value imports are not distinguished.** `extractImportSpecifiers` (`scripts/lib/import-graph.ts:86-107`) ignores `importKind`. A future type-only cycle — which is architecturally benign and common for port/contract types — would hard-fail the gate. Git history shows this already bit once: commit `a120f0c5b chore: break new import cycle, baseline the type-only one`.
3. **Recursive DFS** in `detectCycles` (`scripts/check-dependency-cycles.ts:88-113`) risks stack overflow on pathological deep chains (worked fine at 1861 files; a robustness note only).
4. **Obfuscated closed-bead reference** at `scripts/check-dependency-cycles.ts:15-16` (see Major 1).

### NIT 1 — `PSFN-Satellite-Hub` has the repo's only SCC, and it is half type-only

- `PSFN-Satellite-Hub/src/ts/device-studio-app/stackchan-preview.ts:1` — `import { StackChanThreePreview } from "./stackchan-three-preview.js"` (value)
- `PSFN-Satellite-Hub/src/ts/device-studio-app/stackchan-three-preview.ts:10` — `import type { StackChanPreviewModel } from "./stackchan-preview.js"` (type-only)

Benign at runtime (type edge erased), trivially fixable by moving `StackChanPreviewModel` into a shared types file. No cycle gate covers `PSFN-Satellite-Hub`, so nothing watches it.

### NIT 2 — `src/app/e2e/multi-companion-runtime-validation.ts` imports `test-support/`

One edge: `app/e2e/multi-companion-runtime-validation.ts` → `test-support/postgres-test-harness.ts`. Production tree depending on test-support; harmless for cycles but blurs the tree boundary.

### Seam registry assessment — reality matches, but coverage is thin

`config/import-graph-seams.json` registers exactly three seams: `src/boundary/gateway/server.ts`, `src/core/session/manager.ts`, `src/faculties/memory/writer.ts`. All three files exist (verified), and the reporter is wired in CI (`.github/workflows/ci.yml:81`, informational, never fails). So the registry is **accurate but minimal**: my transitive-dependents ranking shows the real dependency hubs are `shared/utils/types.ts` (1471 dependents), `shared/contracts/trust-contracts.ts` (1281), `system/trust/context-envelope.ts` (1273), and ~10 more `shared/contracts/*` files above 1170 — none registered. The three registered seams are instead the biggest *god-file* hubs. That is a defensible choice (impact reporting matters most where change blast radius is large), but given Major 2/3, `src/persistence/postgres/fleet-auth/gateway-persistence.ts`, `src/app/startup/support/bootstrap-helpers.ts`, and `src/app/startup/composition/channel-runtime.ts` are stronger seam candidates than at least `faculties/memory/writer.ts`.

## Recommendations

Ordered by value/effort. "Mechanical" = safe, no design decision needed.

1. **Prune the cycle baseline (mechanical, ~15 min).** Empty `cycles` in `config/dependency-cycle-baseline.json` (keep `schemaVersion`), point `remediationTracker` at a live "keep it at zero" bead or remove the field per the loader's contract, and replace the hardcoded obfuscated `REMEDIATION_BEAD` in `scripts/check-dependency-cycles.ts:15-16` with the plain string or a live bead. The gate already prints exactly this advice.
2. **Move misplaced runtime helpers out of `src/app/startup/` (mostly mechanical, ~0.5–1 day).** Relocate the voice-provider factories in `app/startup/support/bootstrap-helpers.ts` (the parts imported by `channels/`) and the adapter-factory helpers in `app/startup/composition/channel-runtime.ts` / `channel-lifecycle.ts` (the parts imported by `boundary/gateway/channel-surfaces.ts`) down into `src/channels/backplane/` or `src/system/`, leaving thin re-wiring in the composition root. Fixes Major 3's 5 value edges directly; removes the shortest future-cycle paths.
3. **Move `gateway-persistence.ts` composition wiring to the composition layer (design decision, ~1–2 days).** `src/persistence/postgres/fleet-auth/gateway-persistence.ts` constructs boundary/gateway services; that wiring belongs in `src/app/startup/composition/` (or a `boundary/fleet-auth/composition.ts`) with ports injected. The port *types* currently imported from `boundary/` into 20+ persistence files are fine to keep (mostly type-only), but consider extracting them to `src/shared/contracts/fleet-auth-ports.ts` if the boundary should own policy only. Fixes Major 2's structural risk.
4. **Push `shared/` back to the bottom (mechanical, ~2–4 h).** Move `appendJsonLine` (or a minimal append port) out of `persistence/jsonl.ts` reach for the two telemetry ledgers — either relocate the ledgers to `persistence/` or invert via injection; move `SENSITIVITY_LEVELS/sensitivityOrd` from `system/trust/types.ts` into `shared/contracts/` (they are pure constants/ordering); inject `getRequestContext` into `shared/telemetry/run-charge.ts` or move it; move `resolveRuntimeLayoutMode` usage in `shared/cache/redis-cache.ts` behind a constructor parameter. The 10 type-only `event-bus.ts` → `core/` edges can be fixed later by moving event payload types to `shared/contracts/` (larger, type-only cleanup — optional).
5. **Fix the resolver false-negative in `scripts/lib/import-graph.ts` (mechanical, ~1 h + tests).** Probe candidates with `existsSync` and return the first that exists *and* is in the file set; add a regression test in `scripts/lib/import-graph.test.ts` with a `.tsx`-only target. Prevents silent cycle-masking if file layouts change.
6. **Teach the gate to classify type-only cycles (design decision, ~0.5 day).** Track `importKind` in `extractImportSpecifiers`; report type-only cycles separately (warn / distinct baseline section) instead of hard-failing. Prevents the next `a120f0c5b`-style "baseline the type-only one" commit.
7. **Extend the seam registry (mechanical, ~15 min).** Add `src/persistence/postgres/fleet-auth/gateway-persistence.ts`, `src/app/startup/support/bootstrap-helpers.ts`, `src/app/startup/composition/channel-runtime.ts` to `config/import-graph-seams.json`.
8. **Break the Satellite-Hub nit (mechanical, ~15 min).** Extract `StackChanPreviewModel` to a shared `types.ts`; also consider running the in-repo checker against `PSFN-Satellite-Hub`, `companion-ui/src`, `admin-ui/src` in CI (cheap; requires recommendation 5 for `.tsx`).

## Risks & false positives

**Deliberately NOT flagged:**

- **`core/` → `boundary/pi-agent/` (15+ edges, mostly type-only):** `src/boundary/pi-agent/index.ts:1-19` documents this directory as the single sanctioned coupling point to `@mariozechner/pi-agent-core`, enforced by eslint `no-restricted-imports`. It is a primitive facade; the `boundary/` name is misleading but the pattern is intentional.
- **Type-only upward edges in general** (`shared/event-bus.ts` → `core/`, `persistence/` → `operator/garden/types.ts:14`, `operator/garden/operator-surface.ts:33` → `app/`, etc.): erased at compile time, cannot create runtime cycles, and at trust boundaries `import type` of ports is the correct direction-free pattern. Flagged only where they contradict the stated "shared is standalone" contract (Minor 1) or where they outnumber value edges in an inversion cluster.
- **The 100 group-level mutual pairs as "violations":** with a file-level acyclic graph these are a density metric, not bugs. Reported as Minor 3 for prioritization only.
- **`system/trust/context-envelope.ts` having 1273 transitive dependents:** hub-ness of contracts is by design (`src/shared/contracts/` deliberate duplication across the gateway/agent boundary per AGENTS.md).
- **`scripts/check-dependency-cycles.ts` only scanning `src/`:** documented behavior (`printUsage`), and other roots were verified cycle-free here.

**Candidates needing human verification:**

- Whether `boundary/fleet-auth` + `boundary/gateway` exporting both *policy code* and *port types* consumed by `persistence/` is an accepted interim architecture (fleet-auth is under active development on this branch) or tech debt. If accepted, Major 2 downgrades to "watch item".
- Whether `app/startup/support/bootstrap-helpers.ts` is intended as a semi-public runtime utility module (in which case Major 3 is "documented exception, add it to the seams registry and move on").
- The `--include-tests` graph is double the production graph and ungated; if test-only cycles ever matter to the operator, the gate needs a second baseline. Currently zero, so no action.

## Cross-lane notes

- **Dedup lane:** `persistence/postgres/fleet-auth/gateway-persistence.ts` duplicates construction patterns already present in gateway composition; the fleet-auth port types are declared in `boundary/` while sibling contracts live in `shared/contracts/` — candidate contract-consolidation work.
- **Dead code / legacy lane:** `config/dependency-cycle-baseline.json` (4 dead entries) and the `REMEDIATION_BEAD` obfuscation referencing closed bead PSFN-7hue; bead description references a `.mjs` checker that no longer exists.
- **God-file lane (defensive/slop):** the three registered seams are the repo's giant files — `src/boundary/gateway/server.ts` (153 KB), `src/core/session/manager.ts` (83 KB), `src/faculties/memory/writer.ts` (51 KB); plus `src/shared/event-bus.ts` (1623 lines) whose event map reaches into 10 `core/` modules. Cluster coupling (Minor 3) concentrates exactly around these files.
- **Weak-types lane:** type-only upward edges (esp. `shared/event-bus.ts` → `core/agent/*`) mean shared contracts' shapes are defined inside implementation modules; extracting them would help both lanes.
- **Tooling/CI lane:** cycle gate covers only `src/`; `PSFN-Satellite-Hub`, `companion-ui`, `admin-ui` unguarded; resolver latent bug (recommendation 5) blocks safe reuse for `.tsx` trees.
