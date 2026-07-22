// ── Standing adversarial harness — entrypoint (psfn-framework-86et) ──
//
// Runs the full manipulation-scenario suite against the fixed CogSec / trust /
// privacy / memory modules in-process and prints a pass/fail matrix. Optionally
// writes the structured JSON report.
//
// Usage (from the repo root):
//   npm run shakedown:adversarial
//   npx tsx shakedown/harness/adversarial/run.ts [--json <path>] [--quiet]
//
// Exit code: 0 when every scenario passes; otherwise the count of scenarios that
// did not pass (fail-closed — an errored scenario counts as not-passing).

import { writeFileSync } from 'node:fs';
import { renderMatrix, runScenarios } from './lib/scenario.ts';
import type { AdversarialScenario } from './lib/scenario.ts';
import { scenarios as trustExtraction } from './scenarios/trust-extraction.ts';
import { scenarios as injectionFirewall } from './scenarios/injection-firewall.ts';
import { scenarios as memoryPoisoning } from './scenarios/memory-poisoning.ts';
import { scenarios as disclosureProbing } from './scenarios/disclosure-probing.ts';
import { scenarios as quarantineSink } from './scenarios/quarantine-sink.ts';
import { scenarios as journalBreakGlass } from './scenarios/journal-breakglass.ts';

const ALL_SCENARIOS: readonly AdversarialScenario[] = [
  ...trustExtraction,
  ...injectionFirewall,
  ...memoryPoisoning,
  ...disclosureProbing,
  ...quarantineSink,
  ...journalBreakGlass,
];

function parseArgs(argv: readonly string[]): { jsonPath?: string; quiet: boolean } {
  let jsonPath: string | undefined;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--json requires a path argument');
      }
      jsonPath = next;
      i += 1;
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { ...(jsonPath === undefined ? {} : { jsonPath }), quiet };
}

async function main(): Promise<void> {
  const { jsonPath, quiet } = parseArgs(process.argv.slice(2));

  // Fail-closed on duplicate scenario ids — a copy/paste bug must never silently
  // shadow another scenario's result.
  const ids = new Set<string>();
  for (const scenario of ALL_SCENARIOS) {
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);
  }

  const result = await runScenarios(ALL_SCENARIOS);

  if (!quiet) {
    console.log(renderMatrix(result));
  }
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (!quiet) console.log(`\nJSON report written to ${jsonPath}`);
  }

  const notPassed = result.summary.failed + result.summary.errored;
  process.exitCode = notPassed;
}

main().catch((error: unknown) => {
  // Fail closed: any harness-level error is a non-zero exit, never a silent pass.
  console.error('Adversarial harness aborted:', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
