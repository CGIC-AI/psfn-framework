#!/usr/bin/env node

/** Hard PR limits have no label-based exceptions and no minimum publication size. */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = /^0+$/;

export const CHANGE_BUDGET = Object.freeze({
  pullRequest: Object.freeze({
    files: Object.freeze({ target: 15, maximum: 25 }),
    lines: Object.freeze({ target: 1_500, maximum: 2_500 }),
    commits: Object.freeze({ target: 5, maximum: 8 }),
  }),
  commit: Object.freeze({
    files: Object.freeze({ target: 15, maximum: 25 }),
    lines: Object.freeze({ target: 800, maximum: 2_500 }),
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

function sumNumstat(output, includePath) {
  if (!output) return { files: 0, lines: 0 };

  return output.split('\n').reduce(
    (stats, row) => {
      const [additions, deletions, ...pathParts] = row.split('\t');
      const path = pathParts.join('\t');
      if (includePath && !includePath(path)) return stats;
      stats.files += 1;
      stats.lines += changedLineCount(additions, deletions, path);
      return stats;
    },
    { files: 0, lines: 0 },
  );
}

export function parseNumstat(output) {
  return sumNumstat(output);
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

function isAncestor(ancestor, descendant, cwd) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) return false;
    throw error;
  }
}

function isBaseIntegrationMerge(sha, base, cwd) {
  if (base === EMPTY_TREE) return false;
  const parents = git(['rev-list', '--parents', '-n', '1', sha], cwd).split(' ').slice(1);
  return parents.length > 1 && parents.slice(1).some((parent) => isAncestor(parent, base, cwd));
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

function splitOutput(output) {
  return output ? output.split('\n') : [];
}

function novelMergePaths(sha, parents, cwd) {
  // A file is a novel merge resolution only when it differs from every parent;
  // files that arrive verbatim from a parent (e.g. a plain base integration)
  // are not authored by the PR. `--cc --numstat` over-reports these, so intersect
  // the per-parent change sets to keep only the genuinely resolved paths.
  const perParent = parents.map(
    (parent) => new Set(splitOutput(git(['diff', '--name-only', parent, sha], cwd))),
  );
  return perParent.reduce(
    (common, paths) => new Set([...common].filter((path) => paths.has(path))),
  );
}

function mergeResolutionStats(sha, cwd) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha], cwd).split(' ').slice(1);
  const novelPaths = novelMergePaths(sha, parents, cwd);
  const stats = sumNumstat(
    git(['diff-tree', '--cc', '--numstat', '-r', '--no-commit-id', sha], cwd),
    (path) => novelPaths.has(path),
  );
  if (stats.files === 0) return null;
  return {
    sha,
    subject: git(['show', '-s', '--format=%s', sha], cwd),
    ...stats,
  };
}

export function collectRangeStats({ base, head = 'HEAD', cwd = process.cwd() }) {
  const resolvedHead = git(['rev-parse', '--verify', `${head}^{commit}`], cwd);
  const resolvedBase = resolveBase(base, resolvedHead, cwd);
  const range = commitsInRange(resolvedBase, resolvedHead, cwd).map((sha) => ({
    sha,
    baseIntegration: isBaseIntegrationMerge(sha, resolvedBase, cwd),
  }));
  const commits = range
    .filter(({ baseIntegration }) => !baseIntegration)
    .map(({ sha }) => commitStats(sha, cwd));
  const mergeResolutions = range
    .filter(({ baseIntegration }) => baseIntegration)
    .map(({ sha }) => mergeResolutionStats(sha, cwd))
    .filter((stats) => stats !== null);

  return {
    base: resolvedBase,
    head: resolvedHead,
    commits,
    mergeResolutions,
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

  const patches = [
    ...stats.commits.map((commit) => ({ ...commit, kind: 'commit' })),
    ...(stats.mergeResolutions ?? []).map((resolution) => ({
      ...resolution,
      kind: 'merge resolution',
    })),
  ];
  for (const patch of patches) {
    const scope = `${patch.kind} ${patch.sha.slice(0, 12)} (${patch.subject})`;
    compareMetric(
      scope,
      'files',
      patch.files,
      CHANGE_BUDGET.commit.files,
      warnings,
      violations,
    );
    compareMetric(
      scope,
      'changed lines',
      patch.lines,
      CHANGE_BUDGET.commit.lines,
      warnings,
      violations,
    );
  }

  return { warnings, violations };
}

export function decideChangeBudget(stats) {
  const evaluation = evaluateChangeBudget(stats);
  return { ...evaluation, bypassed: [] };
}

function parseArguments(argv) {
  const options = { base: '', head: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') options.base = argv[++index] ?? '';
    else if (argument === '--head') options.head = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function annotation(kind, message) {
  if (!process.env.GITHUB_ACTIONS) return `${kind.toUpperCase()}: ${message}`;
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return `::${kind} title=Change budget::${escaped}`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const stats = collectRangeStats(options);
  checkDiffIntegrity(stats.base, stats.head);
  const decision = decideChangeBudget(stats);

  console.log(
    `Change budget: ${stats.files} files, ${stats.lines} counted changed lines, ` +
      `${stats.commitCount} commits (${stats.base.slice(0, 12)}..${stats.head.slice(0, 12)})`,
  );
  console.log(
    `PR limits: <=${CHANGE_BUDGET.pullRequest.files.maximum} files, ` +
      `<=${CHANGE_BUDGET.pullRequest.lines.maximum} lines; ` +
      'bundle compatible ready work without imposing a minimum size; ' +
      `<=${CHANGE_BUDGET.pullRequest.commits.maximum} commits`,
  );
  console.log(`Line-count exclusions: ${[...LINE_COUNT_EXCLUSIONS].join(', ')}`);
  for (const warning of decision.warnings) console.log(annotation('warning', warning));
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
