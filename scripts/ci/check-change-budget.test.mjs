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
  resolvePullRequestMetadata,
} from './check-change-budget.mjs';

test('uses the operator-approved PR publication window', () => {
  assert.deepEqual(CHANGE_BUDGET.pullRequest.files, { target: 15, maximum: 25 });
  assert.deepEqual(CHANGE_BUDGET.pullRequest.lines, {
    minimum: 800,
    target: 1_500,
    maximum: 2_500,
  });
  assert.deepEqual(CHANGE_BUDGET.pullRequest.commits, { target: 5, maximum: 8 });
  assert.deepEqual(CHANGE_BUDGET.commit.files, { target: 15, maximum: 25 });
  assert.deepEqual(CHANGE_BUDGET.commit.lines, { target: 800, maximum: 2_500 });
});

test('accepts both endpoints of the mandatory publication window', () => {
  for (const lines of [800, 2_500]) {
    const decision = evaluateChangeBudget({
      files: 25,
      lines,
      commitCount: 8,
      commits: [],
    });
    assert.deepEqual(decision.violations, []);
    assert.ok(decision.warnings.every((warning) => warning.includes('target is')));
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

test('rejects PRs below the mandatory 800-line publication floor', () => {
  const decision = evaluateChangeBudget({
    files: 1,
    lines: 799,
    commitCount: 1,
    commits: [],
  });

  assert.deepEqual(decision.violations, [
    'PR has 799 changed lines; minimum is 800',
  ]);
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
        '900\t300\tapps/satellite-hub/package-lock.json',
        '700\t200\ttools/evals/package-lock.json',
        '800\t0\t.beads/issues.jsonl',
        '7\t3\tsrc/example.ts',
      ].join('\n'),
    ),
    { files: 5, lines: 10 },
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

test('uses exception metadata from the authenticated current-branch PR', () => {
  const metadata = resolvePullRequestMetadata({
    options: { exception: false },
    env: {},
    cwd: '/repo',
    runGh(args, cwd) {
      assert.deepEqual(args, ['pr', 'view', '--json', 'body,labels,state']);
      assert.equal(cwd, '/repo');
      return JSON.stringify({
        state: 'OPEN',
        labels: [{ name: 'change-budget:exception' }],
        body: '## Change-budget exception\nBLOCKER: cannot be bundled before the broken publication gate is restored.',
      });
    },
  });
  const decision = decideChangeBudget(
    { files: 1, lines: 799, commitCount: 1, commits: [] },
    metadata,
  );

  assert.equal(metadata.source, 'GitHub');
  assert.equal(decision.violations.length, 0);
  assert.deepEqual(decision.bypassed, ['PR has 799 changed lines; minimum is 800']);
});

test('fails closed with exact offline metadata instructions', () => {
  assert.throws(
    () =>
      resolvePullRequestMetadata({
        options: { exception: false },
        env: {},
        runGh() {
          throw Object.assign(new Error('gh failed'), { stderr: 'not authenticated' });
        },
      }),
    (error) => {
      assert.match(error.message, /GitHub PR metadata is unavailable \(not authenticated\)/);
      assert.match(error.message, /CHANGE_BUDGET_EXCEPTION=false/);
      assert.match(error.message, /CHANGE_BUDGET_EXCEPTION=true/);
      assert.match(error.message, /CHANGE_BUDGET_PR_BODY/);
      return true;
    },
  );
});

test('accepts the documented explicit offline exception metadata', () => {
  let calledGitHub = false;
  const metadata = resolvePullRequestMetadata({
    options: { exception: false },
    env: {
      CHANGE_BUDGET_EXCEPTION: 'true',
      CHANGE_BUDGET_PR_BODY:
        '## Change-budget exception\nBLOCKER: no compatible work can land until this gate fix lands.',
    },
    runGh() {
      calledGitHub = true;
      throw Object.assign(new Error('gh failed'), { stderr: 'not authenticated' });
    },
  });

  assert.equal(calledGitHub, true);
  assert.match(metadata.source, /^offline \(GitHub unavailable:/);
  assert.equal(metadata.exception, true);
});

test('rejects explicit exception metadata that conflicts with connected GitHub metadata', () => {
  assert.throws(
    () =>
      resolvePullRequestMetadata({
        options: { exception: true },
        env: {
          CHANGE_BUDGET_PR_BODY:
            '## Change-budget exception\nThis must not override the connected PR.',
        },
        runGh() {
          return JSON.stringify({ state: 'OPEN', labels: [], body: '' });
        },
      }),
    /Explicit exception metadata conflicts with GitHub PR metadata/,
  );
});

test('requires a written rationale for a maintainer exception', () => {
  const stats = { files: 1, lines: 799, commitCount: 1, commits: [] };
  const missing = decideChangeBudget(stats, { exception: true });
  assert.match(missing.violations.at(-1), /requires a non-empty/);

  const accepted = decideChangeBudget(stats, {
    exception: true,
    pullRequestBody:
      '## Change-budget exception\nBLOCKER: no compatible train can be published until this fix lands.',
  });
  assert.equal(accepted.violations.length, 0);
  assert.equal(accepted.bypassed.length, 1);
});

test('allows an under-floor exception only for an explicit unbundleable blocker', () => {
  const stats = { files: 1, lines: 799, commitCount: 1, commits: [] };
  const generic = decideChangeBudget(stats, {
    exception: true,
    pullRequestBody: '## Change-budget exception\nSmall cleanup that is ready.',
  });
  assert.deepEqual(generic.violations, [
    'under-800 PR exceptions require a "BLOCKER:" rationale explaining why the blocking change cannot be combined with compatible work',
  ]);

  const blocker = decideChangeBudget(stats, {
    exception: true,
    pullRequestBody:
      '## Change-budget exception\nBLOCKER: required to restore publication, with no compatible work available to bundle.',
  });
  assert.equal(blocker.violations.length, 0);
  assert.deepEqual(blocker.bypassed, [
    'PR has 799 changed lines; minimum is 800',
  ]);
});

test('permits an explicit reviewed exception to bypass publication maximums', () => {
  const decision = decideChangeBudget(
    { files: 26, lines: 800, commitCount: 1, commits: [] },
    {
      exception: true,
      pullRequestBody:
        '## Change-budget exception\nThis coherent migration crosses the provider, gateway, UI, and deployment boundary.',
    },
  );

  assert.deepEqual(decision.violations, []);
  assert.deepEqual(decision.bypassed, [
    'PR has 26 files; maximum is 25',
  ]);
});

test('does not accept stale exception labels', () => {
  const decision = decideChangeBudget(
    { files: 1, lines: 800, commitCount: 1, commits: [] },
    {
      exception: true,
      pullRequestBody: '## Change-budget exception\nNo longer needed.',
    },
  );
  assert.deepEqual(decision.violations, [
    'remove change-budget:exception; this change is within the publication limits',
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
