// ── Corpus replay against the REAL L1 scanner pipeline (hrmrq.141) ──
//
// Offline oracle for corpus fixtures whose layer is 'L1': runs each payload
// through the same createIntakeL1Scanner pipeline and the same checked-in
// rule file (config/intake-l1-rules.json) that production intake uses, and
// reduces the report to a corpus verdict — 'flag' when any risk label is
// raised, 'pass' otherwise. L1 emits no decisions by design (triage, not a
// boundary); the corpus verdict is about label coverage only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntakeRiskLabel } from '../../../../shared/contracts/intake-envelope.js';
import { validateIntakePolicy } from '../../../../system/config/intake-policy-config.ts';
import { createIntakeL1Scanner } from '../scanners/index.ts';
import type { CorpusFixture, CorpusVerdict } from './corpus.ts';

export interface L1ReplayResult {
  verdict: CorpusVerdict;
  labels: IntakeRiskLabel[];
}

const REPO_ROOT = process.cwd();
const RULES_PATH = join(REPO_ROOT, 'config', 'intake-l1-rules.json');
const POLICY_PATH = join(REPO_ROOT, 'config', 'intake-policy.seed.json');

/**
 * Builds a replay function sharing one scanner instance (the rule file is
 * compiled once). Replays at scope 'all' — the zero-false-positive tier
 * applied to untrusted intake, which is where corpus attack payloads arrive
 * by definition.
 */
export function createL1Replayer(): (fixture: CorpusFixture) => L1ReplayResult {
  const policy = validateIntakePolicy(
    JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as unknown,
    POLICY_PATH,
  );
  const scanner = createIntakeL1Scanner({
    rulesPath: RULES_PATH,
    schemeActions: policy.urlScanner.schemeActions,
  });
  return (fixture) => {
    const report = scanner.scan(fixture.payload, { scope: 'all' });
    const labels = [...report.riskLabels].sort();
    return { verdict: labels.length > 0 ? 'flag' : 'pass', labels };
  };
}
