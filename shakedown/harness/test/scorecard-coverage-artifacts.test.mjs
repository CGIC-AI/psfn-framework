import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { SPRINT10_CASE_IDS } from '../cases/sprint10.mjs';

const SCORECARD = fileURLToPath(new URL('../shakedown-scorecard.mjs', import.meta.url));
const REAL_DOC = fileURLToPath(new URL('../../../docs/shakedown.md', import.meta.url));
const REAL_COVERAGE_MAP = fileURLToPath(new URL('../coverage-map.json', import.meta.url));

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function runScorecard(root, inputs, {
  docPath = join(root, 'shakedown.md'),
  coverageMapPath = join(root, 'coverage-map.json'),
} = {}) {
  const json = join(root, 'scorecard.json');
  const markdown = join(root, 'scorecard.md');
  const result = spawnSync(process.execPath, [SCORECARD], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PSFN_SCORECARD_INPUTS: inputs.join(','),
      PSFN_SCORECARD_JSON: json,
      PSFN_SCORECARD_MD: markdown,
      PSFN_SHAKEDOWN_DOC: docPath,
      PSFN_COVERAGE_MAP: coverageMapPath,
    },
  });
  return {
    ...result,
    scorecard: (result.status === 0 || result.status === 1) && existsSync(json)
      ? JSON.parse(readFileSync(json, 'utf8'))
      : null,
  };
}

function createFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'psfn-scorecard-coverage-'));
  writeFileSync(join(root, 'shakedown.md'), [
    '### In scope',
    '',
    '| Surface | Lane / tier | How exercised | Notes |',
    '| --- | --- | --- | --- |',
    '| Support proof | local | support artifact | |',
    '| Conformance proof | all | harness artifact | |',
    '| UI proof | both | UI artifact | |',
  ].join('\n'), 'utf8');
  writeJson(join(root, 'coverage-map.json'), {
    surfaces: {
      'support-proof': { cases: ['multi_companion_crossover_isolation'] },
      'conformance-proof': { cases: ['tier_tool_conformance'] },
      'ui-proof': { cases: ['garden_behavioral_sweep'] },
    },
  });
  return root;
}

test('scorecard unions top-level coverageCaseIds from support, conformance, and UI artifacts', () => {
  const root = createFixtureRoot();
  try {
    const support = join(root, 'support.json');
    const conformance = join(root, 'conformance.json');
    const ui = join(root, 'ui.json');
    writeJson(support, {
      status: 'passed',
      coverageCaseIds: ['multi_companion_crossover_isolation'],
    });
    writeJson(conformance, {
      phase: 'coverage',
      harnessStatus: 'completed',
      coverageCaseIds: ['tier_tool_conformance'],
      results: [{
        caseId: 'capability_refusal_matrix',
        caseStatus: 'ok',
        response: { status: 200 },
      }],
    });
    writeJson(ui, {
      coverageCaseIds: ['garden_behavioral_sweep'],
      pages: [{ name: 'settings', ok: true }],
      failures: [],
    });

    const result = runScorecard(root, [support, conformance, ui]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.scorecard.verdict, 'green');
    for (const row of result.scorecard.coverage.rows) {
      assert.equal(row.covered, true, row.surface);
      assert.equal(row.reason, 'executed_case');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed generic coverage artifact cannot produce a green scorecard', () => {
  const root = createFixtureRoot();
  try {
    const support = join(root, 'support.json');
    writeJson(support, {
      status: 'failed',
      coverageCaseIds: [
        'multi_companion_crossover_isolation',
        'tier_tool_conformance',
        'garden_behavioral_sweep',
      ],
    });

    const result = runScorecard(root, [support]);
    assert.equal(result.status, 1);
    assert.equal(result.scorecard.verdict, 'red');
    assert.deepEqual(
      result.scorecard.failureReasons,
      ['1 external coverage artifact failure(s)'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Sprint 10 coverage map is green with the authored and external proof IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-scorecard-s10-'));
  try {
    const artifact = join(root, 'sprint10.json');
    writeJson(artifact, {
      phase: 'coverage',
      harnessStatus: 'completed',
      coverageCaseIds: [
        'multi_companion_crossover_isolation',
        'icp_durable_turns_restart',
        'icp_fatigue_closeout_reserve',
        'capability_refusal_matrix',
        'tier_tool_conformance',
      ],
      results: SPRINT10_CASE_IDS.map((caseId) => ({
        caseId,
        caseStatus: 'ok',
        response: { status: 200 },
      })),
    });

    const result = runScorecard(root, [artifact], {
      docPath: REAL_DOC,
      coverageMapPath: REAL_COVERAGE_MAP,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.scorecard.verdict, 'green');
    assert.equal(result.scorecard.coverage.uncoveredCount, 0);
    assert.equal(
      result.scorecard.coverage.coveredCount,
      result.scorecard.coverage.surfaceCount,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
