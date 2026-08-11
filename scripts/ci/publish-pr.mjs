#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  REMOTE_ATTESTATION_CONTEXT,
  buildValidatedPushRefspec,
} from './local-delivery-contract.mjs';
import {
  readAttestation,
  resolveLocalGateState,
  runLocalGate,
  validateStateAttestation,
} from './run-local-gate.mjs';
import { waitForPr } from './wait-for-pr.mjs';

function run(executable, args, { stdio = 'pipe' } = {}) {
  const output = execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', stdio, stdio],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function parseArguments(argv) {
  const options = { base: 'main', title: '', bodyFile: '', labels: [], wait: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') options.base = argv[++index] ?? '';
    else if (argv[index] === '--title') options.title = argv[++index] ?? '';
    else if (argv[index] === '--body-file') options.bodyFile = argv[++index] ?? '';
    else if (argv[index] === '--label') {
      const label = argv[++index] ?? '';
      if (!label) throw new Error('--label requires a label name');
      options.labels.push(label);
    }
    else if (argv[index] === '--wait') options.wait = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.base) throw new Error('--base requires a branch');
  return options;
}

function currentPr(branch, runCommand = run) {
  const raw = runCommand('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--limit',
    '2',
    '--json',
    'number,url,isDraft,body,labels',
  ]);
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `GitHub returned malformed PR data for branch ${branch}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(prs)) {
    throw new Error(`GitHub returned malformed PR data for branch ${branch}: expected an array`);
  }
  if (prs.length > 1) throw new Error(`Multiple open PRs found for branch ${branch}`);
  if (prs[0] && (
    !Number.isInteger(prs[0].number)
    || typeof prs[0].url !== 'string'
    || typeof prs[0].isDraft !== 'boolean'
    || (prs[0].body !== undefined && prs[0].body !== null && typeof prs[0].body !== 'string')
    || (prs[0].labels !== undefined && !Array.isArray(prs[0].labels))
  )) {
    throw new Error(`GitHub returned malformed PR data for branch ${branch}`);
  }
  return prs[0] ?? null;
}

async function withChangeBudgetMetadata({ exception, body }, callback) {
  const names = [
    'CHANGE_BUDGET_EXCEPTION',
    'CHANGE_BUDGET_PR_BODY',
    'CHANGE_BUDGET_USE_OFFLINE',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.CHANGE_BUDGET_EXCEPTION = String(exception);
  process.env.CHANGE_BUDGET_PR_BODY = body;
  process.env.CHANGE_BUDGET_USE_OFFLINE = 'true';
  try {
    return await callback();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function updateExistingPrMetadata(prNumber, { title, bodyFile }, runCommand = run) {
  if (!title && !bodyFile) return;

  try {
    const args = [
      'api',
      '--method',
      'PATCH',
      `repos/{owner}/{repo}/pulls/${prNumber}`,
    ];
    if (title) args.push('-f', `title=${title}`);
    if (bodyFile) args.push('-f', `body=${readFileSync(bodyFile, 'utf8')}`);
    runCommand('gh', args, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `Failed to update metadata for PR #${prNumber} before push: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function applyExistingPrLabels(prNumber, labels, runCommand = run) {
  if (labels.length === 0) return;

  try {
    const args = [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/issues/${prNumber}/labels`,
    ];
    for (const label of labels) args.push('-f', `labels[]=${label}`);
    runCommand('gh', args, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `Failed to apply labels to PR #${prNumber} before push: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function requireConfiguredStatusActor(runCommand = run) {
  const expected = runCommand('gh', [
    'variable',
    'list',
    '--json',
    'name,value',
    '--jq',
    '.[] | select(.name == "LOCAL_GATE_STATUS_ACTOR") | .value',
  ]);
  const actual = runCommand('gh', ['api', 'user', '--jq', '.login']);
  if (!expected || actual !== expected) {
    throw new Error(
      `Authenticated gh user ${actual || '(unknown)'} is not the configured local-gate status issuer`,
    );
  }
}

function validateLabels(labels, runCommand = run) {
  for (const label of labels) {
    try {
      runCommand('gh', [
        'api',
        `repos/{owner}/{repo}/labels/${encodeURIComponent(label)}`,
      ]);
    } catch (error) {
      throw new Error(
        `Label "${label}" does not exist or is not accessible; `
        + `fix or remove that --label before publishing: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function markPrReady(reference, runCommand = run) {
  const args = ['pr', 'ready'];
  if (reference !== undefined) args.push(String(reference));
  runCommand('gh', args, { stdio: 'inherit' });
}

function pushBranch(branch, head, { runCommand = run, spawnCommand = spawnSync } = {}) {
  if (runCommand('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed after local validation; refusing to push');
  }
  const remoteRef = `refs/heads/${branch}`;
  const remoteBefore = runCommand('git', ['ls-remote', 'origin', remoteRef]).split(/\s+/)[0];
  const pushArgs = ['push', 'origin'];
  if (remoteBefore) {
    pushArgs.push(`--force-with-lease=${remoteRef}:${remoteBefore}`);
  }
  pushArgs.push(buildValidatedPushRefspec(head, branch));
  const result = spawnCommand('git', pushArgs, {
    stdio: 'inherit',
    env: { ...process.env, PSFN_ATTESTED_PUBLISH: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git push failed with exit ${String(result.status)}`);
  if (runCommand('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed during push; refusing to publish an attestation');
  }
  const remoteHead = runCommand('git', ['ls-remote', '--exit-code', 'origin', remoteRef])
    .split(/\s+/)[0];
  if (remoteHead !== head) throw new Error('Remote branch does not match the attested head');
  runCommand('git', ['branch', '--set-upstream-to', `origin/${branch}`, branch]);
}

function publishRemoteAttestation({ head, base }, runCommand = run) {
  runCommand('gh', [
    'api',
    '--method',
    'POST',
    `repos/{owner}/{repo}/statuses/${head}`,
    '-f',
    'state=success',
    '-f',
    `context=${REMOTE_ATTESTATION_CONTEXT}`,
    '-f',
    `description=base=${base}`,
  ]);
}

export async function publishPr(argv = process.argv.slice(2), {
  runCommand = run,
  spawnCommand = spawnSync,
  runGate = runLocalGate,
  resolveGateState = resolveLocalGateState,
  readGateAttestation = readAttestation,
  validateGateAttestation = validateStateAttestation,
  wait = waitForPr,
  readBodyFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const options = parseArguments(argv);
  const hooksPath = runCommand('git', ['config', '--get', '--default', '', 'core.hooksPath']);
  if (hooksPath !== '.githooks') {
    throw new Error('Local hooks are not installed. Run npm run hooks:install first.');
  }
  const branch = runCommand('git', ['branch', '--show-current']);
  if (!branch || branch === 'main') throw new Error('Publish from a named PR branch, not main.');

  const existing = currentPr(branch, runCommand);
  if (!existing && (!options.title || !options.bodyFile)) {
    throw new Error('A new PR requires --title and --body-file; this prevents an unreviewable empty body.');
  }
  const effectiveBody = options.bodyFile
    ? readBodyFile(options.bodyFile)
    : (existing?.body ?? '');
  const effectiveLabelNames = new Set([
    ...(existing?.labels ?? []).map(({ name }) => name),
    ...options.labels,
  ]);
  const changeBudgetException = effectiveLabelNames.has('change-budget:exception');

  runCommand('git', ['fetch', 'origin', options.base], { stdio: 'inherit' });
  const baseRef = `origin/${options.base}`;
  runCommand('git', ['config', `branch.${branch}.psfnGateBase`, baseRef]);
  await withChangeBudgetMetadata(
    { exception: changeBudgetException, body: effectiveBody },
    () => runGate({ baseRef, changeBudgetException }),
  );
  const state = resolveGateState({ baseRef });
  const validation = validateGateAttestation(
    readGateAttestation(state.attestationPath),
    state,
    { changeBudgetException },
  ).result;
  if (!validation.valid) throw new Error(validation.reason);
  requireConfiguredStatusActor(runCommand);
  validateLabels(options.labels, runCommand);

  if (existing) {
    updateExistingPrMetadata(existing.number, options, runCommand);
    applyExistingPrLabels(existing.number, options.labels, runCommand);
  }

  const flippedReady = existing?.isDraft === true;
  if (flippedReady) {
    markPrReady(existing.number, runCommand);
  }
  try {
    pushBranch(branch, state.head, { runCommand, spawnCommand });
  } catch (error) {
    if (flippedReady) {
      // The PR was flipped ready for a push that never landed; restore draft so
      // CI/Greptile do not run against the stale head. Fail loudly either way.
      try {
        runCommand('gh', ['pr', 'ready', '--undo', String(existing.number)], { stdio: 'inherit' });
        console.error(`Push failed; PR #${existing.number} returned to draft (stale head not published).`);
      } catch (undoError) {
        console.error(
          `Push failed AND restoring draft state failed for PR #${existing.number}; `
          + `it is READY at a stale head — convert it back to draft manually. `
          + `(${undoError instanceof Error ? undoError.message : String(undoError)})`,
        );
      }
    }
    throw error;
  }
  publishRemoteAttestation(state, runCommand);
  if (!existing) {
    const createArgs = [
      'pr',
      'create',
      '--base',
      options.base,
      '--head',
      branch,
      '--title',
      options.title,
      '--body-file',
      options.bodyFile,
    ];
    if (options.labels.length > 0) createArgs.push('--draft');
    for (const label of options.labels) createArgs.push('--label', label);
    try {
      runCommand(
        'gh',
        createArgs,
        { stdio: 'inherit' },
      );
    } catch (error) {
      if (options.labels.length > 0) {
        throw new Error(
          `Creating the labeled draft PR failed. Because gh creates the PR before applying labels, `
          + `a PR may now exist in draft with missing labels. Inspect it with `
          + `\`gh pr list --head ${branch}\`; if present, apply every requested label and run `
          + `\`gh pr ready\`: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (options.labels.length > 0) {
      try {
        markPrReady(undefined, runCommand);
      } catch (error) {
        throw new Error(
          `The new PR was created in draft with its labels but could not be marked ready; `
          + `it remains in draft. Run \`gh pr ready\` from this branch after fixing the error: `
          + errorMessage(error),
          { cause: error },
        );
      }
    }
  }

  const pr = currentPr(branch, runCommand);
  if (!pr) throw new Error(`GitHub did not return a PR for branch ${branch}.`);
  if (options.wait) {
    console.log(`Published ${pr.url} at ${state.head.slice(0, 12)}; waiting for required checks.`);
    await wait({ reference: String(pr.number), expectedHead: state.head });
    surfaceReviewFindings(pr.number, runCommand);
  } else {
    console.log(
      `Published ${pr.url} at ${state.head.slice(0, 12)}; checks continue asynchronously.`,
    );
  }
  return pr;
}

const SEVERITY_BADGE = /badges\/p([01])\.svg/;

/**
 * Passing checks do not mean the paid review was read: the Greptile status
 * succeeds even when its inline comments carry P0/P1 findings. Surface every
 * live inline comment after the wait and refuse success while a live P0/P1
 * finding exists — outdated comments (position null, superseded by a later
 * push) are listed but never block.
 */
function surfaceReviewFindings(prNumber, runCommand = run) {
  const raw = runCommand('gh', [
    'api',
    `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    '--paginate',
  ]);
  const comments = JSON.parse(raw || '[]');
  if (!Array.isArray(comments)) {
    throw new Error(`Unexpected review-comment payload for PR #${prNumber}.`);
  }
  if (comments.length === 0) return;

  const blocking = [];
  for (const comment of comments) {
    const live = comment.position !== null && comment.position !== undefined;
    const severity = SEVERITY_BADGE.exec(String(comment.body ?? ''));
    const headline = String(comment.body ?? '').split('\n').find(line => line.trim()) ?? '';
    const label = severity ? `P${severity[1]}` : 'note';
    console.log(
      `review comment [${label}${live ? '' : ', outdated'}] ${comment.path}:${comment.line ?? comment.original_line} ${headline.slice(0, 160)}`,
    );
    if (live && severity) {
      blocking.push(`${comment.path}:${comment.line ?? comment.original_line} [P${severity[1]}]`);
    }
  }
  if (blocking.length > 0) {
    throw new Error(
      `PR #${prNumber} has ${blocking.length} live P0/P1 review finding(s) — triage them in the PR thread before calling this published: ${blocking.join('; ')}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  publishPr().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
