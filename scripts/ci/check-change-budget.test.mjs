import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CHANGE_BUDGET,
  collectRangeStats,
  decideChangeBudget,
  evaluateChangeBudget,
  extractExceptionReason,
  parseNumstat,
} from './check-change-budget.mjs';

test('uses the operator-approved normal PR target without changing the hard ceiling', () => {
  assert.deepEqual(CHANGE_BUDGET.pullRequest.files, { target: 25, maximum: 25 });
  assert.deepEqual(CHANGE_BUDGET.pullRequest.lines, { target: 1_500, maximum: 2_000 });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-change-budget-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'ci@example.invalid');
  git(cwd, 'config', 'user.name', 'CI Test');
  writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
  git(cwd, 'add', 'seed.txt');
  git(cwd, 'commit', '--quiet', '-m', 'seed');
  return cwd;
}

test('rejects the contaminated PR #124 shape', () => {
  const decision = evaluateChangeBudget({
    files: 907,
    lines: 88_469,
    commitCount: 100,
    commits: [],
  });

  assert.deepEqual(decision.violations, [
    'PR has 907 files; maximum is 25',
    'PR has 88469 changed lines; maximum is 2000',
    'PR has 100 commits; maximum is 8',
  ]);
});

test('counts files but excludes generated tracker and lockfile churn from lines', () => {
  assert.deepEqual(
    parseNumstat(
      [
        '1000\t500\tpackage-lock.json',
        '800\t0\t.beads/issues.jsonl',
        '7\t3\tsrc/example.ts',
      ].join('\n'),
    ),
    { files: 3, lines: 10 },
  );
});

test('collects range and individual commit statistics', () => {
  const cwd = makeRepository();
  const base = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'first.ts'), 'one\ntwo\n');
  git(cwd, 'add', 'first.ts');
  git(cwd, 'commit', '--quiet', '-m', 'first');
  writeFileSync(join(cwd, 'second.ts'), 'three\n');
  git(cwd, 'add', 'second.ts');
  git(cwd, 'commit', '--quiet', '-m', 'second');

  const stats = collectRangeStats({ base, head: 'HEAD', cwd });

  assert.equal(stats.files, 2);
  assert.equal(stats.lines, 3);
  assert.equal(stats.commitCount, 2);
  assert.deepEqual(
    stats.commits.map(({ subject, files, lines }) => ({ subject, files, lines })),
    [
      { subject: 'first', files: 1, lines: 2 },
      { subject: 'second', files: 1, lines: 1 },
    ],
  );
});

test('requires a written rationale for a maintainer exception', () => {
  const stats = { files: 26, lines: 26, commitCount: 1, commits: [] };
  const missing = decideChangeBudget(stats, { exception: true });
  assert.match(missing.violations.at(-1), /requires a non-empty/);

  const accepted = decideChangeBudget(stats, {
    exception: true,
    pullRequestBody: '## Change-budget exception\nPure generated schema migration.',
  });
  assert.equal(accepted.violations.length, 0);
  assert.equal(accepted.bypassed.length, 1);
});

test('does not accept stale exception labels', () => {
  const decision = decideChangeBudget(
    { files: 1, lines: 1, commitCount: 1, commits: [] },
    {
      exception: true,
      pullRequestBody: '## Change-budget exception\nNo longer needed.',
    },
  );
  assert.deepEqual(decision.violations, [
    'remove change-budget:exception; this change is within the hard limits',
  ]);
});

test('extracts rationale without accepting the template comment', () => {
  assert.equal(
    extractExceptionReason(
      '## Change-budget exception\n<!-- Leave blank unless the label is applied. -->\n',
    ),
    '',
  );
});
