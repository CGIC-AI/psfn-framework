// ── Standing adversarial harness — scenario core (psfn-framework-86et) ──
//
// A deterministic, CI-runnable manipulation-scenario harness. Unlike the live
// Layer A shakedown (`shakedown/harness/*.mjs`, which drives a running gateway +
// Postgres + Garden), these scenarios import the REAL fixed CogSec / trust /
// privacy / memory modules in-process and drive them with seeded adversarial
// fixtures — no live LLM, no network, no database. Every scenario maps to a
// security seam closed on the S11 branch and asserts the fixed behaviour holds
// under the specific attack that seam was built to defeat.
//
// Fail-closed contract: a scenario that records zero checks, or that throws,
// is a FAILURE — never a silent pass. Errors are surfaced, never swallowed.

export type ScenarioClassId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CheckResult {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioContext {
  /**
   * Record one adversarial assertion. `passed=false` fails the scenario.
   * `detail` is captured verbatim into the report as evidence.
   */
  check(label: string, passed: boolean, detail?: string): void;
}

export interface AdversarialScenario {
  /** Stable id (used in the matrix and the JSON report). */
  id: string;
  scenarioClass: ScenarioClassId;
  className: string;
  /** Bead ref(s) + module the scenario exercises. */
  seam: string;
  /** The manipulation attempt, in one line. */
  attack: string;
  /** The fixed behaviour that must hold. */
  expectation: string;
  run(ctx: ScenarioContext): Promise<void> | void;
}

export type ScenarioStatus = 'pass' | 'fail' | 'error';

export interface ScenarioReport {
  id: string;
  scenarioClass: ScenarioClassId;
  className: string;
  seam: string;
  attack: string;
  expectation: string;
  status: ScenarioStatus;
  checks: CheckResult[];
  error?: string;
  elapsedMs: number;
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  byClass: Record<string, { total: number; passed: number; failed: number; errored: number }>;
}

export interface HarnessResult {
  generatedAt: string;
  summary: HarnessSummary;
  reports: ScenarioReport[];
}

/** Run one adversarial fixture and capture whether/how it threw. */
export function observeThrow(fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn();
    return { threw: false, message: '' };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Async form of {@link observeThrow}. */
export async function observeThrowAsync(
  fn: () => Promise<unknown>,
): Promise<{ threw: boolean; message: string }> {
  try {
    await fn();
    return { threw: false, message: '' };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) };
  }
}

async function runOne(scenario: AdversarialScenario): Promise<ScenarioReport> {
  const checks: CheckResult[] = [];
  const ctx: ScenarioContext = {
    check(label, passed, detail) {
      checks.push({ label, passed, ...(detail === undefined ? {} : { detail }) });
    },
  };
  const startedAt = performance.now();
  let status: ScenarioStatus;
  let error: string | undefined;
  try {
    await scenario.run(ctx);
    if (checks.length === 0) {
      // Fail closed: a scenario that asserts nothing proves nothing.
      status = 'error';
      error = 'scenario recorded no checks (fail-closed: a scenario must assert at least one thing)';
    } else {
      status = checks.every((c) => c.passed) ? 'pass' : 'fail';
    }
  } catch (thrown) {
    status = 'error';
    error = thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);
  }
  const elapsedMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  return {
    id: scenario.id,
    scenarioClass: scenario.scenarioClass,
    className: scenario.className,
    seam: scenario.seam,
    attack: scenario.attack,
    expectation: scenario.expectation,
    status,
    checks,
    ...(error === undefined ? {} : { error }),
    elapsedMs,
  };
}

export async function runScenarios(scenarios: readonly AdversarialScenario[]): Promise<HarnessResult> {
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    // Sequential: deterministic ordering, and some scenarios mutate shared
    // process-wide state (CONFIG_DIR, temp dirs) that must not interleave.
    reports.push(await runOne(scenario));
  }
  const byClass: HarnessSummary['byClass'] = {};
  for (const report of reports) {
    const key = `${String(report.scenarioClass)}:${report.className}`;
    const bucket = byClass[key] ?? { total: 0, passed: 0, failed: 0, errored: 0 };
    bucket.total += 1;
    if (report.status === 'pass') bucket.passed += 1;
    else if (report.status === 'fail') bucket.failed += 1;
    else bucket.errored += 1;
    byClass[key] = bucket;
  }
  const summary: HarnessSummary = {
    total: reports.length,
    passed: reports.filter((r) => r.status === 'pass').length,
    failed: reports.filter((r) => r.status === 'fail').length,
    errored: reports.filter((r) => r.status === 'error').length,
    byClass,
  };
  return { generatedAt: new Date().toISOString(), summary, reports };
}

const STATUS_GLYPH: Record<ScenarioStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERR ',
};

/** Render the human-readable pass/fail matrix. */
export function renderMatrix(result: HarnessResult): string {
  const lines: string[] = [];
  lines.push('Standing Adversarial Harness — scenario matrix (psfn-framework-86et)');
  lines.push('='.repeat(78));
  let currentClass = -1;
  for (const report of result.reports) {
    if (report.scenarioClass !== currentClass) {
      currentClass = report.scenarioClass;
      lines.push('');
      lines.push(`Class ${String(report.scenarioClass)} — ${report.className}`);
    }
    lines.push(`  [${STATUS_GLYPH[report.status]}] ${report.id}`);
    lines.push(`         seam: ${report.seam}`);
    lines.push(`         attack: ${report.attack}`);
    if (report.status !== 'pass') {
      for (const check of report.checks.filter((c) => !c.passed)) {
        lines.push(`         ✗ ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
      }
      if (report.error) lines.push(`         ! ${report.error.split('\n')[0]}`);
    }
  }
  lines.push('');
  lines.push('-'.repeat(78));
  const s = result.summary;
  lines.push(
    `TOTAL ${String(s.total)}  PASS ${String(s.passed)}  FAIL ${String(s.failed)}  ERROR ${String(s.errored)}`,
  );
  return lines.join('\n');
}
