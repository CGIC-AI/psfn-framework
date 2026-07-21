#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendAttestationMarker, validateAttestation } from './local-delivery-contract.mjs';
import { readAttestation, resolveLocalGateState, runLocalGate } from './run-local-gate.mjs';
import { waitForPr } from './wait-for-pr.mjs';

function run(executable, args, { allowFailure = false, stdio = 'pipe' } = {}) {
  try {
    const output = execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', stdio, allowFailure ? 'ignore' : stdio],
    });
    return typeof output === 'string' ? output.trim() : '';
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
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
  const output = run('gh', ['pr', 'view', branch, '--json', 'number,url,body,title'], {
    allowFailure: true,
  });
  return output ? JSON.parse(output) : null;
}

function pushBranch(branch) {
  const result = spawnSync('git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git push failed with exit ${String(result.status)}`);
}

export async function publishPr(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const hooksPath = run('git', ['config', '--get', 'core.hooksPath'], { allowFailure: true });
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
  const attestation = readAttestation(state.attestationPath);
  const validation = validateAttestation(attestation, { head: state.head, base: state.base });
  if (!validation.valid) throw new Error(validation.reason);

  const existing = currentPr(branch);
  if (!existing && (!options.title || !options.bodyFile)) {
    throw new Error('A new PR requires --title and --body-file; this prevents an unreviewable empty body.');
  }
  const originalBody = existing?.body ?? '';
  const body = appendAttestationMarker(
    options.bodyFile ? readFileSync(options.bodyFile, 'utf8') : originalBody,
    attestation,
  );
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'psfn-pr-'));
  const attestedBodyFile = join(temporaryDirectory, 'body.md');
  writeFileSync(attestedBodyFile, body, { mode: 0o600 });

  try {
    if (existing) {
      const editArgs = ['pr', 'edit', String(existing.number), '--body-file', attestedBodyFile];
      if (options.title) editArgs.push('--title', options.title);
      run('gh', editArgs, { stdio: 'inherit' });
      try {
        pushBranch(branch);
      } catch (error) {
        const restoreFile = join(temporaryDirectory, 'restore.md');
        writeFileSync(restoreFile, originalBody, { mode: 0o600 });
        run('gh', ['pr', 'edit', String(existing.number), '--body-file', restoreFile], {
          stdio: 'inherit',
        });
        throw error;
      }
    } else {
      pushBranch(branch);
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
        attestedBodyFile,
      ];
      run('gh', createArgs, { stdio: 'inherit' });
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
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
