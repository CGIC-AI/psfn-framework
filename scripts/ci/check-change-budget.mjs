#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = /^0+$/;

export const CHANGE_BUDGET = Object.freeze({
  pullRequest: Object.freeze({
    files: Object.freeze({ target: 12, maximum: 25 }),
    lines: Object.freeze({ target: 800, maximum: 2_000 }),
    commits: Object.freeze({ target: 5, maximum: 8 }),
  }),
  commit: Object.freeze({
    files: Object.freeze({ target: 8, maximum: 15 }),
    lines: Object.freeze({ target: 400, maximum: 800 }),
  }),
});

export const LINE_COUNT_EXCLUSIONS = new Set([
  '.beads/issues.jsonl',
  'admin-ui/package-lock.json',
  'companion-ui/package-lock.json',
  'package-lock.json',
]);

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function changedLineCount(additions, deletions, path) {
  if (LINE_COUNT_EXCLUSIONS.has(path)) return 0;
  const added = additions === '-' ? 0 : Number.parseInt(additions, 10);
  const deleted = deletions === '-' ? 0 : Number.parseInt(deletions, 10);
  return added + deleted;
}

export function parseNumstat(output) {
  if (!output) return { files: 0, lines: 0 };

  return output.split('\n').reduce(
    (stats, row) => {
      const [additions, deletions, ...pathParts] = row.split('\t');
      const path = pathParts.join('\t');
      stats.files += 1;
      stats.lines += changedLineCount(additions, deletions, path);
      return stats;
    },
    { files: 0, lines: 0 },
  );
}

function resolveBase(base, head, cwd) {
  if (base && !ZERO_SHA.test(base)) {
    git(['rev-parse', '--verify', `${base}^{commit}`], cwd);
    return git(['merge-base', base, head], cwd);
  }

  try {
    return git(['rev-parse', '--verify', `${head}^`], cwd);
  } catch {
    return EMPTY_TREE;
  }
}

function commitsInRange(base, head, cwd) {
  const range = base === EMPTY_TREE ? head : `${base}..${head}`;
  const output = git(['rev-list', '--reverse', range], cwd);
  return output ? output.split('\n') : [];
}

function commitStats(sha, cwd) {
  const ancestry = git(['rev-list', '--parents', '-n', '1', sha], cwd).split(' ');
  const parent = ancestry[1] ?? EMPTY_TREE;
  const stats = parseNumstat(git(['diff', '--numstat', '-M', parent, sha], cwd));
  return {
    sha,
    subject: git(['show', '-s', '--format=%s', sha], cwd),
    ...stats,
  };
}

export function collectRangeStats({ base, head = 'HEAD', cwd = process.cwd() }) {
  const resolvedHead = git(['rev-parse', '--verify', `${head}^{commit}`], cwd);
  const resolvedBase = resolveBase(base, resolvedHead, cwd);
  const commits = commitsInRange(resolvedBase, resolvedHead, cwd).map((sha) =>
    commitStats(sha, cwd),
  );

  return {
    base: resolvedBase,
    head: resolvedHead,
    commits,
    commitCount: commits.length,
    ...parseNumstat(git(['diff', '--numstat', '-M', resolvedBase, resolvedHead], cwd)),
  };
}

export function checkDiffIntegrity(base, head, cwd = process.cwd()) {
  git(['diff', '--check', base, head], cwd);
}

function compareMetric(scope, name, value, budget, warnings, violations) {
  if (value > budget.maximum) {
    violations.push(`${scope} has ${value} ${name}; maximum is ${budget.maximum}`);
  } else if (value > budget.target) {
    warnings.push(`${scope} has ${value} ${name}; target is ${budget.target}`);
  }
}

export function evaluateChangeBudget(stats) {
  const warnings = [];
  const violations = [];

  compareMetric(
    'PR',
    'files',
    stats.files,
    CHANGE_BUDGET.pullRequest.files,
    warnings,
    violations,
  );
  compareMetric(
    'PR',
    'changed lines',
    stats.lines,
    CHANGE_BUDGET.pullRequest.lines,
    warnings,
    violations,
  );
  compareMetric(
    'PR',
    'commits',
    stats.commitCount,
    CHANGE_BUDGET.pullRequest.commits,
    warnings,
    violations,
  );

  for (const commit of stats.commits) {
    const scope = `commit ${commit.sha.slice(0, 12)} (${commit.subject})`;
    compareMetric(
      scope,
      'files',
      commit.files,
      CHANGE_BUDGET.commit.files,
      warnings,
      violations,
    );
    compareMetric(
      scope,
      'changed lines',
      commit.lines,
      CHANGE_BUDGET.commit.lines,
      warnings,
      violations,
    );
  }

  return { warnings, violations };
}

export function extractExceptionReason(body) {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  const match = withoutComments.match(
    /(?:^|\n)## Change-budget exception\s*\n([\s\S]*?)(?=\n## |\s*$)/i,
  );
  return match?.[1].trim() ?? '';
}

export function decideChangeBudget(stats, { exception = false, pullRequestBody = '' } = {}) {
  const evaluation = evaluateChangeBudget(stats);
  if (!exception) return { ...evaluation, bypassed: [] };

  const reason = extractExceptionReason(pullRequestBody);
  if (!reason) {
    return {
      warnings: evaluation.warnings,
      violations: [
        ...evaluation.violations,
        'change-budget:exception requires a non-empty "## Change-budget exception" PR section',
      ],
      bypassed: [],
    };
  }
  if (evaluation.violations.length === 0) {
    return {
      warnings: evaluation.warnings,
      violations: ['remove change-budget:exception; this change is within the hard limits'],
      bypassed: [],
    };
  }
  return {
    warnings: evaluation.warnings,
    violations: [],
    bypassed: evaluation.violations,
  };
}

function parseArguments(argv) {
  const options = { base: '', head: 'HEAD', exception: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') options.base = argv[++index] ?? '';
    else if (argument === '--head') options.head = argv[++index] ?? '';
    else if (argument === '--exception') options.exception = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function annotation(kind, message) {
  if (!process.env.GITHUB_ACTIONS) return `${kind.toUpperCase()}: ${message}`;
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return `::${kind} title=Change budget::${escaped}`;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const stats = collectRangeStats(options);
  checkDiffIntegrity(stats.base, stats.head);
  const decision = decideChangeBudget(stats, {
    exception: options.exception,
    pullRequestBody: env.CHANGE_BUDGET_PR_BODY ?? '',
  });

  console.log(
    `Change budget: ${stats.files} files, ${stats.lines} counted changed lines, ` +
      `${stats.commitCount} commits (${stats.base.slice(0, 12)}..${stats.head.slice(0, 12)})`,
  );
  console.log(
    `Targets: <=${CHANGE_BUDGET.pullRequest.files.target} files, ` +
      `<=${CHANGE_BUDGET.pullRequest.lines.target} lines, ` +
      `<=${CHANGE_BUDGET.pullRequest.commits.target} commits`,
  );
  console.log(`Line-count exclusions: ${[...LINE_COUNT_EXCLUSIONS].join(', ')}`);

  for (const warning of decision.warnings) console.log(annotation('warning', warning));
  for (const bypassed of decision.bypassed) {
    console.log(annotation('warning', `Maintainer exception: ${bypassed}`));
  }
  for (const violation of decision.violations) console.error(annotation('error', violation));

  return decision.violations.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(annotation('error', error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
