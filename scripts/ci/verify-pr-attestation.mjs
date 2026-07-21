#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { validateRemoteAttestation } from './local-delivery-contract.mjs';

function readStatuses(repository, head) {
  return JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/commits/${head}/statuses`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

export async function waitForRemoteAttestation({
  repository,
  head,
  base,
  attempts = 20,
  intervalMs = 3_000,
  read = readStatuses,
}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return validateRemoteAttestation(read(repository, head), base);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(intervalMs);
    }
  }
  throw lastError;
}

export async function main(env = process.env) {
  await waitForRemoteAttestation({
    repository: env.GITHUB_REPOSITORY ?? '',
    head: env.HEAD_SHA ?? '',
    base: env.BASE_SHA ?? '',
  });
  console.log(`Remote local-gate status matches ${env.HEAD_SHA?.slice(0, 12)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
