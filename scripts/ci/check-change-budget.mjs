#!/usr/bin/env node

/**
 * PR metadata input contract:
 * - Connected runs use `gh pr view` for the open PR associated with the current branch.
 * - Offline runs set CHANGE_BUDGET_EXCEPTION=false when no exception label is present.
 * - Offline maintainer exceptions use --exception or
 *   CHANGE_BUDGET_EXCEPTION=true together with CHANGE_BUDGET_PR_BODY containing
 *   the complete PR body and a non-empty exception rationale. Under-floor
 *   exceptions additionally require a `BLOCKER:` rationale.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EXCEPTION_LABEL = 'change-budget:exception';
const ZERO_SHA = /^0+$/;

export const CHANGE_BUDGET = Object.freeze({
  pullRequest: Object.freeze({
    files: Object.freeze({ target: 15, maximum: 25 }),
    lines: Object.freeze({ minimum: 800, target: 1_500, maximum: 2_500 }),
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
  'apps/satellite-hub/package-lock.json',
  'companion-ui/package-lock.json',
  'package-lock.json',
  'tools/evals/package-lock.json',
]);

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gh(args, cwd) {
  return execFileSync('gh', args, {
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

function compareMinimum(scope, name, value, budget, violations) {
  if (budget.minimum !== undefined && value < budget.minimum) {
    violations.push(`${scope} has ${value} ${name}; minimum is ${budget.minimum}`);
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
  compareMinimum(
    'PR',
    'changed lines',
    stats.lines,
    CHANGE_BUDGET.pullRequest.lines,
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

export function extractExceptionReason(body) {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  const match = withoutComments.match(
    /(?:^|\n)## Change-budget exception\s*\n([\s\S]*?)(?=\n## |\s*$)/i,
  );
  return match?.[1].trim() ?? '';
}

function errorDetail(error) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr ?? '').trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function parseOfflineException(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('CHANGE_BUDGET_EXCEPTION must be exactly "true" or "false"');
}

function offlinePullRequestMetadata(options, env) {
  const envException = parseOfflineException(env.CHANGE_BUDGET_EXCEPTION);
  if (options.exception && envException === false) {
    throw new Error('--exception conflicts with CHANGE_BUDGET_EXCEPTION=false');
  }

  const exception = options.exception || envException === true;
  const bodyProvided = env.CHANGE_BUDGET_PR_BODY !== undefined;
  if (envException === false) {
    return { exception: false, pullRequestBody: env.CHANGE_BUDGET_PR_BODY ?? '', source: 'offline' };
  }
  if (exception && bodyProvided) {
    return { exception: true, pullRequestBody: env.CHANGE_BUDGET_PR_BODY, source: 'offline' };
  }
  return null;
}

function parseGitHubPullRequest(output) {
  let pullRequest;
  try {
    pullRequest = JSON.parse(output);
  } catch (error) {
    throw new Error(`gh returned invalid PR JSON: ${errorDetail(error)}`);
  }
  if (!pullRequest || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
    throw new Error('gh returned PR metadata that is not an object');
  }
  if (typeof pullRequest.state !== 'string') {
    throw new Error('gh returned a PR state that is not a string');
  }
  if (pullRequest.body !== null && typeof pullRequest.body !== 'string') {
    throw new Error('gh returned a PR body that is neither a string nor null');
  }
  if (
    !Array.isArray(pullRequest.labels) ||
    pullRequest.labels.some(
      (label) => !label || typeof label !== 'object' || typeof label.name !== 'string',
    )
  ) {
    throw new Error('gh returned malformed PR labels');
  }
  return {
    state: pullRequest.state,
    exception: pullRequest.labels.some(({ name }) => name === EXCEPTION_LABEL),
    pullRequestBody: pullRequest.body ?? '',
    source: 'GitHub',
  };
}

function offlineInstructions(detail) {
  return (
    `GitHub PR metadata is unavailable (${detail}). For offline validation, set ` +
    'CHANGE_BUDGET_EXCEPTION=false when the PR has no exception label; or set ' +
    'CHANGE_BUDGET_EXCEPTION=true and CHANGE_BUDGET_PR_BODY to the complete PR body ' +
    'containing a non-empty "## Change-budget exception" rationale.'
  );
}

export function resolvePullRequestMetadata({
  options,
  env,
  cwd = process.cwd(),
  runGh = gh,
}) {
  const offline = offlinePullRequestMetadata(options, env);

  let output;
  try {
    output = runGh(['pr', 'view', '--json', 'body,labels,state'], cwd);
  } catch (error) {
    if (offline) {
      return { ...offline, source: `offline (GitHub unavailable: ${errorDetail(error)})` };
    }
    throw new Error(offlineInstructions(errorDetail(error)));
  }
  const connected = parseGitHubPullRequest(output);
  if (connected.state !== 'OPEN') {
    if (offline) {
      return { ...offline, source: `offline (GitHub PR state: ${connected.state})` };
    }
    throw new Error(offlineInstructions(`current-branch PR state is ${connected.state}, not OPEN`));
  }

  const explicitException = options.exception || parseOfflineException(env.CHANGE_BUDGET_EXCEPTION);
  if (explicitException !== undefined && explicitException !== connected.exception) {
    throw new Error(
      `Explicit exception metadata conflicts with GitHub PR metadata: ${EXCEPTION_LABEL} is ` +
        `${connected.exception ? 'present' : 'absent'}`,
    );
  }
  const { state: _state, ...metadata } = connected;
  return metadata;
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
  const underPublicationFloor =
    stats.lines < CHANGE_BUDGET.pullRequest.lines.minimum;
  if (evaluation.violations.length === 0) {
    return {
      warnings: evaluation.warnings,
      violations: ['remove change-budget:exception; this change is within the publication limits'],
      bypassed: [],
    };
  }
  const floorViolation =
    `PR has ${stats.lines} changed lines; minimum is ${CHANGE_BUDGET.pullRequest.lines.minimum}`;
  if (underPublicationFloor && !/^BLOCKER:\s+\S/i.test(reason)) {
    return {
      warnings: evaluation.warnings,
      violations: [
        ...evaluation.violations.filter(violation => violation !== floorViolation),
        'under-800 PR exceptions require a "BLOCKER:" rationale explaining why the blocking change cannot be combined with compatible work',
      ],
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
  const metadata = resolvePullRequestMetadata({ options, env });
  const decision = decideChangeBudget(stats, metadata);

  console.log(
    `Change budget: ${stats.files} files, ${stats.lines} counted changed lines, ` +
      `${stats.commitCount} commits (${stats.base.slice(0, 12)}..${stats.head.slice(0, 12)})`,
  );
  console.log(
    `PR limits: <=${CHANGE_BUDGET.pullRequest.files.maximum} files, ` +
      `${CHANGE_BUDGET.pullRequest.lines.minimum}-${CHANGE_BUDGET.pullRequest.lines.maximum} lines; ` +
      'bundle compatible work instead of publishing small PRs; ' +
      `<=${CHANGE_BUDGET.pullRequest.commits.maximum} commits`,
  );
  console.log(`Line-count exclusions: ${[...LINE_COUNT_EXCLUSIONS].join(', ')}`);
  console.log(`Exception metadata: ${metadata.source}`);

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
