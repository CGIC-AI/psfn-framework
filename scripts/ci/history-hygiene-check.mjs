#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = 'config/history-hygiene.json';
export const ISSUES_SNAPSHOT_PATH = '.beads/issues.jsonl';

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function parseHistoryHygieneConfig(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }
  for (const key of ['schemaVersion', 'maxIssuesSnapshotBytes', 'maxIssuesSnapshotVersionsPerGeneration']) {
    if (!Number.isSafeInteger(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`${CONFIG_PATH}.${key} must be a positive integer`);
    }
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported history-hygiene schema: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.rewriteGenerationMarker !== 'string' || parsed.rewriteGenerationMarker.length === 0) {
    throw new Error(`${CONFIG_PATH}.rewriteGenerationMarker must be a non-empty path`);
  }
  return parsed;
}

export function classifyForbiddenTrackedPath(file) {
  if (/^\.beads\/.*\.log$/iu.test(file)) return 'Beads runtime log';
  if (/^working_docs\/.*(?:session|transcript).*\.(?:zip|tar|gz|7z)$/iu.test(file)) {
    return 'session archive';
  }
  return null;
}

export function evaluateHistoryHygiene({
  config,
  trackedFiles,
  issuesSnapshotBytes,
  markerPresent,
  issuesSnapshotVersions,
}) {
  const violations = [];
  for (const file of trackedFiles) {
    const classification = classifyForbiddenTrackedPath(file);
    if (classification) violations.push(`${classification} is tracked: ${file}`);
  }
  if (issuesSnapshotBytes > config.maxIssuesSnapshotBytes) {
    violations.push(
      `${ISSUES_SNAPSHOT_PATH} is ${issuesSnapshotBytes} bytes; maximum is ${config.maxIssuesSnapshotBytes}`,
    );
  }
  if (
    markerPresent
    && issuesSnapshotVersions > config.maxIssuesSnapshotVersionsPerGeneration
  ) {
    violations.push(
      `${ISSUES_SNAPSHOT_PATH} has ${issuesSnapshotVersions} versions since the rewrite generation; maximum is ${config.maxIssuesSnapshotVersionsPerGeneration}`,
    );
  }
  return violations;
}

export function checkHistoryHygiene(cwd = process.cwd()) {
  const config = parseHistoryHygieneConfig(readFileSync(`${cwd}/${CONFIG_PATH}`, 'utf8'));
  const trackedFiles = git(['ls-files'], cwd).split('\n').filter(Boolean);
  const issuesPath = `${cwd}/${ISSUES_SNAPSHOT_PATH}`;
  const issuesSnapshotBytes = existsSync(issuesPath) ? statSync(issuesPath).size : 0;
  const markerPath = `${cwd}/${config.rewriteGenerationMarker}`;
  const markerPresent = existsSync(markerPath);
  let issuesSnapshotVersions = 0;

  if (markerPresent) {
    const markerCommit = git([
      'log',
      '--diff-filter=A',
      '--format=%H',
      '--reverse',
      '--',
      config.rewriteGenerationMarker,
    ], cwd).split('\n').filter(Boolean)[0];
    if (!markerCommit) {
      throw new Error(`${config.rewriteGenerationMarker} exists but has no introducing commit`);
    }
    const output = git([
      'log',
      '--format=%H',
      `${markerCommit}^..HEAD`,
      '--',
      ISSUES_SNAPSHOT_PATH,
    ], cwd);
    issuesSnapshotVersions = output ? output.split('\n').filter(Boolean).length : 0;
  }

  return {
    config,
    issuesSnapshotBytes,
    issuesSnapshotVersions,
    markerPresent,
    violations: evaluateHistoryHygiene({
      config,
      trackedFiles,
      issuesSnapshotBytes,
      markerPresent,
      issuesSnapshotVersions,
    }),
  };
}

function main() {
  try {
    const result = checkHistoryHygiene();
    if (result.violations.length > 0) {
      console.error('History-hygiene check failed:');
      for (const violation of result.violations) console.error(`- ${violation}`);
      process.exit(1);
    }
    const generation = result.markerPresent
      ? `${result.issuesSnapshotVersions}/${result.config.maxIssuesSnapshotVersionsPerGeneration} snapshot versions in the active generation`
      : 'rewrite generation not activated yet';
    console.log(
      `History-hygiene check passed (${result.issuesSnapshotBytes}/${result.config.maxIssuesSnapshotBytes} snapshot bytes; ${generation}).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
