#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { evaluateRequiredChecks } from './local-delivery-contract.mjs';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readPr(reference) {
  return JSON.parse(
    gh(['pr', 'view', reference, '--json', 'number,url,headRefOid,statusCheckRollup']),
  );
}

function normalizeChecks(statusCheckRollup) {
  return statusCheckRollup.map((check) => ({
    name: check.name ?? check.context ?? '',
    status: check.status ?? (check.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED'),
    conclusion: check.conclusion ?? check.state ?? '',
    detailsUrl: check.detailsUrl ?? check.targetUrl ?? '',
  }));
}

export async function waitForPr({
  reference,
  expectedHead,
  timeoutMs = 45 * 60 * 1_000,
  intervalMs = 15_000,
} = {}) {
  if (!reference) throw new Error('PR reference is required');
  if (!expectedHead) throw new Error('Expected PR head is required');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pr = readPr(String(reference));
    const checks = normalizeChecks(pr.statusCheckRollup ?? []);
    const result = evaluateRequiredChecks({
      expectedHead,
      actualHead: pr.headRefOid,
      checks,
    });
    console.log(`PR #${pr.number}: ${result.reason}`);
    if (result.state === 'passed') return pr;
    if (result.state === 'failed') {
      for (const check of checks.filter(({ conclusion }) => conclusion && conclusion !== 'SUCCESS')) {
        console.error(`${check.name}: ${check.conclusion}${check.detailsUrl ? ` ${check.detailsUrl}` : ''}`);
      }
      throw new Error(`Failure handback for ${expectedHead.slice(0, 12)}: ${result.reason}`);
    }
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ci-required and Greptile Review on ${expectedHead.slice(0, 12)}.`);
}

function parseArguments(argv) {
  const options = { reference: '', expectedHead: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--pr') options.reference = argv[++index] ?? '';
    else if (argv[index] === '--head') options.expectedHead = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArguments(process.argv.slice(2));
  waitForPr(options).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
