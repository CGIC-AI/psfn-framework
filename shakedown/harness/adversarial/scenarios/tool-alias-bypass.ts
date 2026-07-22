// Class 7 — pre_tool_use hook alias-bypass attempts (psfn-framework-ijtak.2).
//
// Seam:
//  - 816w: pre_tool_use decision hooks are selected by a tool-name/alias matcher
//    (src/boundary/gateway/hook-registry.ts `HookRegistry.evaluatePreToolUse`,
//    lines matching `context.toolName` OR `context.aliases`). The attack class
//    it defeats: an operator policy hook written against a tool's CANONICAL name
//    must still fire when an adversary invokes the same underlying tool through
//    one of its retired aliases (`shell` gated, invoked as `shell_exec`), and a
//    policy written against an alias must fire on the canonical call ("and vice
//    versa"). If matching were canonical-name-only, the alias would slip the
//    gate entirely.
//
// REACHABILITY NOTE — the 816w end-to-end fix is NOT fully on this branch.
//   The registry's alias-aware matching (`evaluatePreToolUse` iterating
//   `context.aliases`) IS present here and is what these scenarios drive
//   directly against the real production module. The gate-site population of
//   `context.aliases` — the `resolveToolAliasMatchers` helper in
//   `src/boundary/gateway/pre-tool-hook.ts` that the fixed `createPreToolHookGate`
//   uses — ships with 816w on `feat/s11-egress`; on THIS branch
//   `createPreToolHookGate` still hardcodes `aliases: []` (pre-tool-hook.ts).
//   So these scenarios locally reconstruct, from the REAL first-party tool
//   registry (`getRetiredToolAlias` / `getCanonicalToolSurface`), the identifier
//   set the fixed gate will feed, and assert the matching contract the fix
//   depends on. The `selftest.ts` witness (find→fix→rerun) reproduces the
//   pre-816w miss (empty `aliases` → the alias slips the gate) and confirms the
//   resolved set closes it, and stands as the regression witness for when the
//   gate-site wiring lands on the assembled base.

import {
  HookMatcher,
  HookRegistry,
} from '../../../../src/boundary/gateway/hook-registry.ts';
import type {
  PreToolUseHookContext,
} from '../../../../src/boundary/gateway/pre-tool-hook.ts';
import {
  getCanonicalToolSurface,
  getRetiredToolAlias,
} from '../../../../src/core/agent/tool-surface/registry.ts';
import type { AdversarialScenario } from '../lib/scenario.ts';

const CLASS = 7;
const CLASS_NAME = 'Pre_tool_use hook alias-bypass attempts';

// Real, operator-gated first-party tools (boundary domain) paired with a retired
// alias the model/registry still resolves. Sourced from the live tool-surface
// registry, not invented, so the fixtures track the shipped alias table.
const GATED_ALIAS_PAIRS: readonly { canonical: string; alias: string }[] = [
  { canonical: 'shell', alias: 'shell_exec' },
  { canonical: 'repo', alias: 'repo_commit' },
  { canonical: 'web', alias: 'web_fetch' },
  { canonical: 'fs', alias: 'fs_read' },
];

/**
 * The full identifier set that denotes the same underlying first-party tool:
 * the canonical name plus every retired alias registered for it. This is exactly
 * what 816w's `resolveToolAliasMatchers` resolves at the gate; here we build it
 * from the REAL registry so the fixture cannot drift from the shipped alias
 * table. An unknown name resolves to just itself (fail-closed: no phantom
 * expansion).
 */
function resolveToolIdentifierSet(invokedName: string): readonly string[] {
  const retired = getRetiredToolAlias(invokedName);
  const canonicalName = retired ? retired.canonicalName : invokedName;
  const canonical = getCanonicalToolSurface(canonicalName);
  if (!canonical) return [invokedName];
  const ids = new Set<string>([canonical.name]);
  for (const a of canonical.retiredAliases) ids.add(a.alias);
  return [...ids];
}

/** The `context.aliases` the fixed gate feeds: the identifier set minus the invoked name. */
function aliasMatchersFor(invokedName: string): readonly string[] {
  return resolveToolIdentifierSet(invokedName).filter((n) => n !== invokedName);
}

function contextFor(invokedName: string, aliases: readonly string[]): PreToolUseHookContext {
  return {
    toolName: invokedName,
    aliases,
    input: { note: 'seeded adversarial invocation' },
    capabilityTier: 'autonomous',
  };
}

/** A fresh registry carrying one operator deny-policy hook matched by `patterns`. */
function registryWithDenyPolicy(hookName: string, patterns: readonly string[]): HookRegistry {
  const registry = new HookRegistry();
  registry.register({
    name: hookName,
    mode: 'sync_decision',
    sourcePath: 'adversarial-harness://tool-alias-bypass',
    matcher: new HookMatcher(patterns),
    handler: () => ({ decision: 'deny', reason: `${hookName}: operator-gated tool` }),
  });
  return registry;
}

export const scenarios: AdversarialScenario[] = [
  {
    id: 's7_gated_tool_denied_via_alias',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: '816w — hook-registry.ts evaluatePreToolUse (tool-name/alias matcher)',
    attack:
      'Operator gates a tool by its CANONICAL name; the adversary invokes the same tool through a retired alias to slip the pre_tool_use policy.',
    expectation:
      'The alias invocation is still gated: the policy hook fires and BLOCKS the call, identically to the canonical invocation. Canonical-only matching would have let the alias through.',
    async run(t) {
      for (const { canonical, alias } of GATED_ALIAS_PAIRS) {
        // Sanity: the alias genuinely resolves to this canonical in the real registry.
        const retired = getRetiredToolAlias(alias);
        t.check(
          `registry resolves alias "${alias}" -> canonical "${canonical}"`,
          retired?.canonicalName === canonical,
          `resolved=${String(retired?.canonicalName)}`,
        );

        const registry = registryWithDenyPolicy(`gate:${canonical}`, [canonical]);

        // Attack: adversary invokes via the alias; the fixed gate resolves the
        // alias's sibling identifiers (incl. the canonical) into context.aliases.
        const aliasEval = await registry.evaluatePreToolUse(
          contextFor(alias, aliasMatchersFor(alias)),
          { timeoutMs: 0 },
        );
        t.check(
          `alias invocation "${alias}" is BLOCKED by the canonical policy`,
          aliasEval.outcome === 'block' && aliasEval.blockingHook === `gate:${canonical}`,
          `outcome=${aliasEval.outcome} blockingHook=${String(aliasEval.blockingHook)} matched=${String(aliasEval.matchedHookCount)}`,
        );
      }
    },
  },
  {
    id: 's7_policy_written_on_alias_catches_canonical',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: '816w — hook-registry.ts evaluatePreToolUse (reverse direction)',
    attack:
      'Operator writes the policy against a retired ALIAS; the adversary invokes the tool by its canonical name, betting the alias-scoped policy will not match.',
    expectation:
      'The canonical invocation is still gated: the fixed gate carries the alias among the resolved identifiers, so the alias-scoped policy fires and BLOCKS. Matching is symmetric — alias policy ⇄ canonical call.',
    async run(t) {
      for (const { canonical, alias } of GATED_ALIAS_PAIRS) {
        const registry = registryWithDenyPolicy(`gate-alias:${alias}`, [alias]);
        const canonicalEval = await registry.evaluatePreToolUse(
          contextFor(canonical, aliasMatchersFor(canonical)),
          { timeoutMs: 0 },
        );
        t.check(
          `canonical invocation "${canonical}" is BLOCKED by the alias-scoped policy`,
          canonicalEval.outcome === 'block' && canonicalEval.blockingHook === `gate-alias:${alias}`,
          `outcome=${canonicalEval.outcome} blockingHook=${String(canonicalEval.blockingHook)}`,
        );
      }
    },
  },
  {
    id: 's7_canonical_control_and_policy_specificity',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: '816w — hook-registry.ts evaluatePreToolUse (negative controls)',
    attack:
      'CONTROL: confirm the fix does not change the canonical path and is not a blanket deny — a gated policy must still fire on its own canonical name and must NOT intercept an unrelated tool (or that tool\'s aliases).',
    expectation:
      'Canonical-name behaviour is unchanged (still BLOCKED); an unrelated tool and its aliases are ALLOWED (matchedHookCount 0) — the policy stays specific to the tool it names.',
    async run(t) {
      // Negative control A: canonical behaviour unchanged.
      const registry = registryWithDenyPolicy('gate:shell', ['shell']);
      const canonicalEval = await registry.evaluatePreToolUse(
        contextFor('shell', aliasMatchersFor('shell')),
        { timeoutMs: 0 },
      );
      t.check(
        'canonical "shell" invocation is still BLOCKED (canonical behaviour unchanged)',
        canonicalEval.outcome === 'block' && canonicalEval.blockingHook === 'gate:shell',
        `outcome=${canonicalEval.outcome} blockingHook=${String(canonicalEval.blockingHook)}`,
      );

      // Negative control B: an UNRELATED tool is not swept up — not a blanket deny.
      const unrelatedCanonical = await registry.evaluatePreToolUse(
        contextFor('web', aliasMatchersFor('web')),
        { timeoutMs: 0 },
      );
      t.check(
        'unrelated canonical "web" is ALLOWED by the shell policy (no blanket deny)',
        unrelatedCanonical.outcome === 'allow' && unrelatedCanonical.matchedHookCount === 0,
        `outcome=${unrelatedCanonical.outcome} matched=${String(unrelatedCanonical.matchedHookCount)}`,
      );

      // Negative control C: an unrelated tool's ALIAS is likewise not intercepted.
      const unrelatedAlias = await registry.evaluatePreToolUse(
        contextFor('web_fetch', aliasMatchersFor('web_fetch')),
        { timeoutMs: 0 },
      );
      t.check(
        'unrelated alias "web_fetch" is ALLOWED by the shell policy (specificity holds across aliases)',
        unrelatedAlias.outcome === 'allow' && unrelatedAlias.matchedHookCount === 0,
        `outcome=${unrelatedAlias.outcome} matched=${String(unrelatedAlias.matchedHookCount)}`,
      );
    },
  },
];
