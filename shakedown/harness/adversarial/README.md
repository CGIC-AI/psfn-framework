# Standing Adversarial Harness (psfn-framework-86et)

The repeatable manipulation-scenario suite for the privacy / trust / CogSec /
memory boundaries. It is the deterministic, CI-runnable counterpart to the live
Layer A shakedown in the parent directory.

## What it is (and is not)

- **In-process, deterministic.** Each scenario imports the **real fixed
  modules** (`src/core/cogsec/**`, `src/system/trust/**`, `src/system/config/**`,
  `src/boundary/gateway/**`, `src/operator/garden/**`) and drives them with
  seeded adversarial fixtures. **No live LLM, no network, no Postgres, no
  Garden.** It runs anywhere `tsx` runs and finishes in seconds.
- **Not** the live shakedown. The `*.mjs` harness one level up drives a running
  split runtime and proves end-to-end wiring; this suite proves the *fixed
  behaviour of the seams themselves* under specific attacks, cheaply and on
  every change.

## Run it

```bash
# From the repo root:
npm run shakedown:adversarial                       # pass/fail matrix to stdout
npm run shakedown:adversarial -- --json out.json    # also write the structured report
npm run shakedown:adversarial -- --quiet            # suppress the matrix (exit code only)
npm run shakedown:adversarial:selftest              # regression witness + harness-core checks

# Or directly:
npx tsx shakedown/harness/adversarial/run.ts [--json <path>] [--quiet]
```

Exit code = number of non-passing scenarios (0 = all green). A scenario that
throws, or records zero assertions, is **fail-closed** to a non-passing result.

## Layout

```
adversarial/
  run.ts                 entrypoint: registers every scenario, prints the matrix, writes JSON
  selftest.ts            find→fix→rerun regression witness (5ixyj) + harness-core coverage
  lib/
    scenario.ts          scenario contract, runner, reporter, matrix renderer
    breakglass-context.ts fixture for the fleet Garden request context (class 6)
  scenarios/
    trust-extraction.ts   class 1 — extraction across trust tiers
    injection-firewall.ts class 2 — injection / namshub per intake surface
    memory-poisoning.ts   class 3 — memory-poisoning / trust-grooming drift
    disclosure-probing.ts class 4 — system-prompt / internal-state disclosure
    quarantine-sink.ts    class 5 — quarantine / sink-gate bypass
    journal-breakglass.ts class 6 — journal read via admin surface
    tool-alias-bypass.ts  class 7 — pre_tool_use hook alias-bypass
```

## Scenario classes → seams

| Class | Seam(s) | Key module(s) |
| --- | --- | --- |
| 1 | trust ceiling / visibility / boundary / consent gates | `src/system/trust/policy.ts` `evaluateMemoryPolicy` |
| 2 | 5ixyj singular-anchor L1 rule; cyy7l enforce fail-closed | `intake-l1-rules.json` + `scanners/`, `intake/compose-screening.ts` |
| 3 | memory candidacy; jvbt notice exclusion; trust-mutation guard | `memory-candidacy.ts`, `intake-firewall-notice-templates.ts`, `trust/policy.ts` |
| 4 | d269 / qgqw.3 canary egress clamp (send / tool / reply / stream) | `boundary/gateway/canary-egress-guard.ts` |
| 5 | qg13 sink posture; jvbt provenance; d269 reply canary | `system/config/intake-policy-config.ts`, `intake-firewall-notice-templates.ts`, `canary-egress-guard.ts` |
| 6 | 57gt journal break-glass default-deny + single-use | `operator/garden/services/privacy-break-glass-service.ts` |
| 7 | 816w pre_tool_use hook tool-name/alias matcher (canonical ⇄ alias) + gate-site alias resolution | `boundary/gateway/hook-registry.ts` `evaluatePreToolUse`, `boundary/gateway/pre-tool-hook.ts` `createPreToolHookGate`, `core/agent/tool-surface/registry.ts` `resolveToolAliasMatchers` |

> **Class 7 coverage.** Two layers are exercised. (a) The registry's alias-aware
> matching (`evaluatePreToolUse` iterating `context.aliases`) is driven directly
> by the scenarios that reconstruct the identifier set from the real tool
> registry (`s7_gated_tool_denied_via_alias`,
> `s7_policy_written_on_alias_catches_canonical`,
> `s7_canonical_control_and_policy_specificity`). (b) The gate site itself —
> `createPreToolHookGate` wired with the production `resolveToolAliasMatchers` —
> is driven end-to-end by `s7_gate_site_alias_denial`, so gate-site alias
> resolution is load-bearing: a regression that fed an empty alias set would let
> the alias slip the canonical policy and fail that scenario. `selftest.ts`
> carries the find→fix witness at both layers (empty-`aliases` registry miss and
> empty-resolver gate-site miss), confirming the resolved set / production
> resolver closes each.

## Writing a scenario

Add an `AdversarialScenario` to the relevant `scenarios/*.ts` module:

```ts
{
  id: 's5_my_new_bypass_attempt',
  scenarioClass: 5,
  className: 'Quarantine / sink-gate bypass attempts',
  seam: 'qg13 — intake-policy-config.ts',
  attack: 'One line: what the adversary does.',
  expectation: 'One line: the fixed behaviour that must hold.',
  run(t) {
    const outcome = /* drive a real module with a fixture */;
    t.check('the guarantee holds', outcome === expected, `evidence=${outcome}`);
  },
}
```

Rules:

- Assert against **real modules**, never a re-implementation of the guard.
- Record at least one `t.check(...)`; a zero-check scenario fails closed.
- Include a CONTROL (a legitimate case that should pass) whenever the guard could
  plausibly be a blanket deny.
- Keep it deterministic: seeded inputs only, no clock/network/DB dependence.
- A new module must be imported and spread into `ALL_SCENARIOS` in `run.ts`.

## When a scenario finds a real breach

File it as a bead, keep the scenario as the standing regression witness, and — if
the fix lands in base code — leave a self-test that reproduces the pre-fix miss
and confirms the fix (see `selftest.ts`, which does exactly this for the 5ixyj
singular-injection anchor).
