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
import {
  createIntakeL1Scanner,
  isIntakeScanScope,
} from '../scanners/index.ts';
import {
  CORPUS_REPLAY_SCOPE_BY_SCENARIO,
  CORPUS_REPLAY_SCENARIOS,
  type CorpusFixture,
  type CorpusReplayScenario,
  type CorpusVerdict,
} from './corpus.ts';
import type { IntakeScanScope } from '../scanners/types.ts';

export interface L1ReplayResult {
  scenario: CorpusReplayScenario;
  scope: IntakeScanScope;
  verdict: CorpusVerdict;
  labels: IntakeRiskLabel[];
}

const REPO_ROOT = process.cwd();
const RULES_PATH = join(REPO_ROOT, 'config', 'intake-l1-rules.json');
const POLICY_PATH = join(REPO_ROOT, 'config', 'intake-policy.seed.json');

/**
 * Builds a replay function sharing one scanner instance (the rule file is
 * compiled once). Every fixture must name its scenario and scanner scope;
 * sourceClass remains provenance metadata and never selects the scope.
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
    const replay = fixture.replay;
    if (!replay) {
      throw new Error(`L1 corpus fixture '${fixture.id}' is missing its replay scenario and scope`);
    }
    if (!(CORPUS_REPLAY_SCENARIOS as readonly string[]).includes(replay.scenario)) {
      throw new Error(
        `L1 corpus fixture '${fixture.id}' replay scenario '${String(replay.scenario)}' is invalid`,
      );
    }
    if (!isIntakeScanScope(replay.scope)) {
      throw new Error(
        `L1 corpus fixture '${fixture.id}' replay scope '${String(replay.scope)}' is invalid`,
      );
    }
    const expectedScope = CORPUS_REPLAY_SCOPE_BY_SCENARIO[replay.scenario];
    if (replay.scope !== expectedScope) {
      throw new Error(
        `L1 corpus fixture '${fixture.id}' replay scenario '${replay.scenario}' requires scope `
        + `'${expectedScope}', got '${replay.scope}'`,
      );
    }
    const report = scanner.scan(fixture.payload, { scope: replay.scope });
    const labels = [...report.riskLabels].sort();
    return {
      scenario: replay.scenario,
      scope: replay.scope,
      verdict: labels.length > 0 ? 'flag' : 'pass',
      labels,
    };
  };
}
