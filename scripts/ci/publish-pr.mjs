#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
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
  const options = { base: 'main', title: '', bodyFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') options.base = argv[++index] ?? '';
    else if (argv[index] === '--title') options.title = argv[++index] ?? '';
    else if (argv[index] === '--body-file') options.bodyFile = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.base) throw new Error('--base requires a branch');
  return options;
}

function currentPr(branch, runCommand = run) {
  const prs = JSON.parse(
    runCommand('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'number,url,isDraft',
    ]),
  );
  if (prs.length > 1) throw new Error(`Multiple open PRs found for branch ${branch}`);
  if (prs[0] && (
    !Number.isInteger(prs[0].number)
    || typeof prs[0].url !== 'string'
    || typeof prs[0].isDraft !== 'boolean'
  )) {
    throw new Error(`GitHub returned malformed PR data for branch ${branch}`);
  }
  return prs[0] ?? null;
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

function pushBranch(branch, head, { runCommand = run, spawnCommand = spawnSync } = {}) {
  if (runCommand('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed after local validation; refusing to push');
  }
  const result = spawnCommand('git', ['push', 'origin', buildValidatedPushRefspec(head, branch)], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git push failed with exit ${String(result.status)}`);
  if (runCommand('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed during push; refusing to publish an attestation');
  }
  const remoteHead = runCommand('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`])
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
} = {}) {
  const options = parseArguments(argv);
  const hooksPath = runCommand('git', ['config', '--get', '--default', '', 'core.hooksPath']);
  if (hooksPath !== '.githooks') {
    throw new Error('Local hooks are not installed. Run npm run hooks:install first.');
  }
  const branch = runCommand('git', ['branch', '--show-current']);
  if (!branch || branch === 'main') throw new Error('Publish from a named PR branch, not main.');

  runCommand('git', ['fetch', 'origin', options.base], { stdio: 'inherit' });
  const baseRef = `origin/${options.base}`;
  runCommand('git', ['config', `branch.${branch}.psfnGateBase`, baseRef]);
  await runGate({ baseRef });
  const state = resolveGateState({ baseRef });
  const validation = validateGateAttestation(readGateAttestation(state.attestationPath), state).result;
  if (!validation.valid) throw new Error(validation.reason);
  requireConfiguredStatusActor(runCommand);

  const existing = currentPr(branch, runCommand);
  if (!existing && (!options.title || !options.bodyFile)) {
    throw new Error('A new PR requires --title and --body-file; this prevents an unreviewable empty body.');
  }
  if (existing && (options.title || options.bodyFile)) {
    const editArgs = ['pr', 'edit', String(existing.number)];
    if (options.title) editArgs.push('--title', options.title);
    if (options.bodyFile) editArgs.push('--body-file', options.bodyFile);
    runCommand('gh', editArgs, { stdio: 'inherit' });
  }

  const flippedReady = existing?.isDraft === true;
  if (flippedReady) {
    runCommand('gh', ['pr', 'ready', String(existing.number)], { stdio: 'inherit' });
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
    runCommand(
      'gh',
      [
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
      ],
      { stdio: 'inherit' },
    );
  }

  const pr = currentPr(branch, runCommand);
  if (!pr) throw new Error(`GitHub did not return a PR for branch ${branch}.`);
  console.log(`Published ${pr.url} at ${state.head.slice(0, 12)}; waiting for CI and Greptile.`);
  await wait({ reference: String(pr.number), expectedHead: state.head });
  surfaceReviewFindings(pr.number, runCommand);
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
