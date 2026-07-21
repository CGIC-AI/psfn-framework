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

function currentPr(branch) {
  const prs = JSON.parse(
    run('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'number,url',
    ]),
  );
  if (prs.length > 1) throw new Error(`Multiple open PRs found for branch ${branch}`);
  return prs[0] ?? null;
}

function requireConfiguredStatusActor() {
  const expected = run('gh', [
    'variable',
    'list',
    '--json',
    'name,value',
    '--jq',
    '.[] | select(.name == "LOCAL_GATE_STATUS_ACTOR") | .value',
  ]);
  const actual = run('gh', ['api', 'user', '--jq', '.login']);
  if (!expected || actual !== expected) {
    throw new Error(
      `Authenticated gh user ${actual || '(unknown)'} is not the configured local-gate status issuer`,
    );
  }
}

function pushBranch(branch, head) {
  if (run('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed after local validation; refusing to push');
  }
  const result = spawnSync('git', ['push', 'origin', buildValidatedPushRefspec(head, branch)], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git push failed with exit ${String(result.status)}`);
  if (run('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Branch HEAD changed during push; refusing to publish an attestation');
  }
  const remoteHead = run('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`])
    .split(/\s+/)[0];
  if (remoteHead !== head) throw new Error('Remote branch does not match the attested head');
  run('git', ['branch', '--set-upstream-to', `origin/${branch}`, branch]);
}

function publishRemoteAttestation({ head, base }) {
  run('gh', [
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

export async function publishPr(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const hooksPath = run('git', ['config', '--get', '--default', '', 'core.hooksPath']);
  if (hooksPath !== '.githooks') {
    throw new Error('Local hooks are not installed. Run npm run hooks:install first.');
  }
  const branch = run('git', ['branch', '--show-current']);
  if (!branch || branch === 'main') throw new Error('Publish from a named PR branch, not main.');

  run('git', ['fetch', 'origin', options.base], { stdio: 'inherit' });
  const baseRef = `origin/${options.base}`;
  run('git', ['config', `branch.${branch}.psfnGateBase`, baseRef]);
  await runLocalGate({ baseRef });
  const state = resolveLocalGateState({ baseRef });
  const validation = validateStateAttestation(readAttestation(state.attestationPath), state).result;
  if (!validation.valid) throw new Error(validation.reason);
  requireConfiguredStatusActor();

  const existing = currentPr(branch);
  if (!existing && (!options.title || !options.bodyFile)) {
    throw new Error('A new PR requires --title and --body-file; this prevents an unreviewable empty body.');
  }
  if (existing && (options.title || options.bodyFile)) {
    const editArgs = ['pr', 'edit', String(existing.number)];
    if (options.title) editArgs.push('--title', options.title);
    if (options.bodyFile) editArgs.push('--body-file', options.bodyFile);
    run('gh', editArgs, { stdio: 'inherit' });
  }

  pushBranch(branch, state.head);
  publishRemoteAttestation(state);
  if (!existing) {
    run(
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

  const pr = currentPr(branch);
  if (!pr) throw new Error(`GitHub did not return a PR for branch ${branch}.`);
  console.log(`Published ${pr.url} at ${state.head.slice(0, 12)}; waiting for CI and Greptile.`);
  await waitForPr({ reference: String(pr.number), expectedHead: state.head });
  return pr;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  publishPr().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
