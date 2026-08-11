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
    gh(['pr', 'view', reference, '--json', 'number,url,headRefOid,statusCheckRollup,labels']),
  );
}

function parseTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : -1;
}

function parseActionsRunId(detailsUrl) {
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(detailsUrl ?? '');
  return match ? Number.parseInt(match[1], 10) : -1;
}

function compareCheckRecency(left, right) {
  if (
    left.detailsUrl === right.detailsUrl
    && left.startedAt === right.startedAt
    && left.completedAt === right.completedAt
    && left.status === right.status
    && left.conclusion === right.conclusion
  ) {
    return 0;
  }

  const leftRunId = parseActionsRunId(left.detailsUrl);
  const rightRunId = parseActionsRunId(right.detailsUrl);
  if (leftRunId >= 0 || rightRunId >= 0) {
    if (leftRunId < 0 || rightRunId < 0) return null;
    if (leftRunId !== rightRunId) return leftRunId - rightRunId;
  } else {
    const leftStartedAt = parseTimestamp(left.startedAt);
    const rightStartedAt = parseTimestamp(right.startedAt);
    if (leftStartedAt < 0 || rightStartedAt < 0) return null;
    if (leftStartedAt !== rightStartedAt) return leftStartedAt - rightStartedAt;
  }

  const leftCompletedAt = parseTimestamp(left.completedAt);
  const rightCompletedAt = parseTimestamp(right.completedAt);
  if (leftCompletedAt >= 0 || rightCompletedAt >= 0) {
    if (leftCompletedAt < 0) return -1;
    if (rightCompletedAt < 0) return 1;
    if (leftCompletedAt !== rightCompletedAt) return leftCompletedAt - rightCompletedAt;
  }
  return null;
}

function ambiguousCheck(name) {
  return {
    name,
    status: 'COMPLETED',
    conclusion: 'AMBIGUOUS',
    detailsUrl: '',
    startedAt: '',
    completedAt: '',
    ambiguous: true,
  };
}

function normalizeChecks(statusCheckRollup) {
  const latestByName = new Map();
  for (const rawCheck of statusCheckRollup) {
    const check = {
      name: rawCheck.name ?? rawCheck.context ?? '',
      status: rawCheck.status ?? (rawCheck.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED'),
      conclusion: rawCheck.conclusion ?? rawCheck.state ?? '',
      detailsUrl: rawCheck.detailsUrl ?? rawCheck.targetUrl ?? '',
      startedAt: rawCheck.startedAt ?? '',
      completedAt: rawCheck.completedAt ?? '',
    };
    const current = latestByName.get(check.name);
    if (!current) {
      latestByName.set(check.name, check);
      continue;
    }
    if (current.ambiguous) continue;
    const recency = compareCheckRecency(check, current);
    if (recency === null) {
      latestByName.set(check.name, ambiguousCheck(check.name));
    } else if (recency > 0) {
      latestByName.set(check.name, check);
    }
  }
  return [...latestByName.values()];
}

export async function waitForPr({
  reference,
  expectedHead,
  timeoutMs = 45 * 60 * 1_000,
  intervalMs = 15_000,
  read = readPr,
  sleep = delay,
  now = Date.now,
} = {}) {
  if (!reference) throw new Error('PR reference is required');
  if (!expectedHead) throw new Error('Expected PR head is required');
  const deadline = now() + timeoutMs;
  let lastReason = 'required checks have not appeared.';

  while (now() < deadline) {
    const pr = await read(String(reference));
    const checks = normalizeChecks(pr.statusCheckRollup ?? []);
    const result = evaluateRequiredChecks({
      expectedHead,
      actualHead: pr.headRefOid,
      checks,
      requireGreptile: (pr.labels ?? []).some(({ name }) => name === 'review:greptile'),
    });
    lastReason = result.reason;
    console.log(`PR #${pr.number}: ${result.reason}`);
    if (result.state === 'passed') return pr;
    if (result.state === 'failed') {
      for (const check of checks.filter(({ conclusion }) => conclusion && conclusion !== 'SUCCESS')) {
        console.error(`${check.name}: ${check.conclusion}${check.detailsUrl ? ` ${check.detailsUrl}` : ''}`);
      }
      throw new Error(`Failure handback for ${expectedHead.slice(0, 12)}: ${result.reason}`);
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
  throw new Error(
    `Timed out waiting for required checks on ${expectedHead.slice(0, 12)}. `
      + `Last observed state: ${lastReason}`,
  );
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
