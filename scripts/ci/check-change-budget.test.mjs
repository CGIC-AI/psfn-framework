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
  parseNumstat,
} from './check-change-budget.mjs';

test('uses the operator-approved PR publication window', () => {
  assert.deepEqual(CHANGE_BUDGET.pullRequest.files, { target: 15, maximum: 25 });
  assert.deepEqual(CHANGE_BUDGET.pullRequest.lines, { target: 1_500, maximum: 2_500 });
  assert.deepEqual(CHANGE_BUDGET.pullRequest.commits, { target: 5, maximum: 8 });
  assert.deepEqual(CHANGE_BUDGET.commit.files, { target: 15, maximum: 25 });
  assert.deepEqual(CHANGE_BUDGET.commit.lines, { target: 800, maximum: 2_500 });
});

test('accepts any PR size through the hard maximum', () => {
  for (const lines of [1, 1_500, 2_500]) {
    const decision = evaluateChangeBudget({
      files: 15,
      lines,
      commitCount: 5,
      commits: [],
    });
    assert.deepEqual(decision.violations, []);
  }

  assert.deepEqual(
    evaluateChangeBudget({
      files: 25,
      lines: 2_501,
      commitCount: 8,
      commits: [],
    }).violations,
    ['PR has 2501 changed lines; maximum is 2500'],
  );
});

test('accepts a small coherent PR without exception ceremony', () => {
  const decision = evaluateChangeBudget({
    files: 1,
    lines: 6,
    commitCount: 1,
    commits: [],
  });

  assert.deepEqual(decision, { warnings: [], violations: [] });
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
    'PR has 88469 changed lines; maximum is 2500',
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

test('excludes a merge of the PR base from the PR-owned delta', () => {
  const cwd = makeRepository();
  const initialBase = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(cwd, 'feature.ts'), 'owned\n');
  git(cwd, 'add', 'feature.ts');
  git(cwd, 'commit', '--quiet', '-m', 'feature work');

  git(cwd, 'switch', '--quiet', '-c', 'main', initialBase);
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(join(cwd, `base-${index}.ts`), `base ${index}\n`);
  }
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--quiet', '-m', 'large base change');
  const currentBase = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'switch', '--quiet', 'feature');
  git(cwd, 'merge', '--quiet', '--no-ff', 'main', '-m', 'merge main');

  const stats = collectRangeStats({ base: currentBase, head: 'HEAD', cwd });

  assert.equal(stats.files, 1);
  assert.equal(stats.lines, 1);
  assert.equal(stats.commitCount, 1);
  assert.deepEqual(stats.mergeResolutions, []);
  assert.deepEqual(
    stats.commits.map(({ subject, files, lines }) => ({ subject, files, lines })),
    [{ subject: 'feature work', files: 1, lines: 1 }],
  );
});

test('retains PR-owned commits merged from a non-base topic branch', () => {
  const cwd = makeRepository();
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '--quiet', '-c', 'feature');
  git(cwd, 'switch', '--quiet', '-c', 'topic');
  for (let index = 0; index < 9; index += 1) {
    writeFileSync(join(cwd, `topic-${index}.ts`), `topic ${index}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', `topic ${index}`);
  }
  git(cwd, 'switch', '--quiet', 'feature');
  git(cwd, 'merge', '--quiet', '--no-ff', 'topic', '-m', 'merge topic');

  const stats = collectRangeStats({ base, head: 'HEAD', cwd });

  assert.equal(stats.commitCount, 10);
  assert.equal(stats.commits.length, 10);
  assert.match(evaluateChangeBudget(stats).violations.at(-1), /PR has 10 commits/);
});

test('checks PR-owned conflict resolution changes against the per-commit budget', () => {
  const cwd = makeRepository();
  writeFileSync(join(cwd, 'shared.ts'), 'original\n');
  git(cwd, 'add', 'shared.ts');
  git(cwd, 'commit', '--quiet', '-m', 'shared base');
  const initialBase = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(cwd, 'shared.ts'), 'feature\n');
  git(cwd, 'commit', '--quiet', '-am', 'feature change');

  git(cwd, 'switch', '--quiet', '-c', 'main', initialBase);
  writeFileSync(join(cwd, 'shared.ts'), 'main\n');
  git(cwd, 'commit', '--quiet', '-am', 'main change');
  const currentBase = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'switch', '--quiet', 'feature');
  assert.throws(() => git(cwd, 'merge', '--no-ff', 'main', '-m', 'merge main'));
  writeFileSync(join(cwd, 'shared.ts'), 'resolved\n'.repeat(2_501));
  git(cwd, 'add', 'shared.ts');
  git(cwd, 'commit', '--quiet', '-m', 'merge main with resolution');

  const stats = collectRangeStats({ base: currentBase, head: 'HEAD', cwd });
  const resolution = stats.mergeResolutions.find(
    ({ subject }) => subject === 'merge main with resolution',
  );

  assert.equal(stats.commitCount, 1);
  assert.ok(resolution);
  assert.ok(resolution.lines > CHANGE_BUDGET.commit.lines.maximum);
  assert.ok(
    evaluateChangeBudget(stats).violations.some((violation) =>
      violation.startsWith(`merge resolution ${resolution.sha.slice(0, 12)}`),
    ),
  );
});

test('hard limits are evaluated without GitHub or exception metadata', () => {
  const decision = decideChangeBudget({
    files: 26,
    lines: 6,
    commitCount: 1,
    commits: [],
  });

  assert.deepEqual(decision.violations, ['PR has 26 files; maximum is 25']);
  assert.deepEqual(decision.bypassed, []);
});
