#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Keep this list minimal. It contains the approved maintainer identity plus
// automation/hosted-git identities that are already present in repository
// history. Alternate human identities are intentionally not accepted.
export const ALLOWED_COMMIT_EMAILS = Object.freeze([
  'codex@local',
  'codex@local.invalid',
  'codex@localhost',
  'codex@openai.com',
  'noreply@github.com',
]);

export function resolveAllowedCommitEmails({ cwd = process.cwd(), env = process.env } = {}) {
  const environmentEmails = (env.DELIVERY_ALLOWED_COMMIT_EMAILS ?? '')
    .split(/[\n,]/)
    .map((email) => email.trim())
    .filter(Boolean);
  let repositoryEmails = [];
  try {
    const output = git(['config', '--get-all', 'delivery.allowedCommitEmail'], cwd);
    repositoryEmails = output ? output.split('\n').map((email) => email.trim()).filter(Boolean) : [];
  } catch (error) {
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 1) {
      throw error;
    }
  }
  return [...new Set([...ALLOWED_COMMIT_EMAILS, ...environmentEmails, ...repositoryEmails])];
}

// These immutable source heads retain their original author and committer
// identities. Only commits in their ancestry receive the provenance exemption;
// descendants and ordinary framework commits still use ALLOWED_COMMIT_EMAILS.
export const PRESERVED_IMPORT_HEADS = Object.freeze([
  Object.freeze({
    component: 'satellite-hub',
    head: '6aa49aadb7536eec88c85573986d1af6102ab5f4',
  }),
  Object.freeze({
    component: 'eval-toolkit',
    head: 'a6e540ad77b48ef1801d361d241f01d5f218098f',
  }),
]);

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertAncestor(base, head, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) {
      throw new Error(`base ${base} is not an ancestor of head ${head}`);
    }
    throw error;
  }
}

function commitsInRange(base, head, cwd) {
  const output = git(['rev-list', '--reverse', `${base}..${head}`], cwd);
  return output ? output.split('\n') : [];
}

function preservedImportCommits(importHeads, resolvedHead, cwd) {
  const commits = new Set();
  for (const entry of importHeads) {
    if (
      !entry
      || typeof entry.component !== 'string'
      || entry.component.length === 0
      || typeof entry.head !== 'string'
      || !/^[0-9a-f]{40}$/.test(entry.head)
    ) {
      throw new Error('preserved import heads require a component and exact 40-character SHA');
    }
    const sourceHead = git(['rev-parse', '--verify', `${entry.head}^{commit}`], cwd);
    assertAncestor(sourceHead, resolvedHead, cwd);
    const sourceCommits = git(['rev-list', sourceHead], cwd);
    for (const sha of sourceCommits ? sourceCommits.split('\n') : []) commits.add(sha);
  }
  return commits;
}

/**
 * @param {{
 *   base: string;
 *   head?: string;
 *   cwd?: string;
 *   allowedEmails?: readonly string[];
 *   preservedImportHeads?: readonly { component: string; head: string }[];
 * }} options
 */
export function checkCommitIdentityRange({
  base,
  head = 'HEAD',
  cwd = process.cwd(),
  allowedEmails,
  preservedImportHeads = PRESERVED_IMPORT_HEADS,
}) {
  if (!base) throw new Error('base ref is required');
  if (!head) throw new Error('head ref is required');
  const resolvedAllowedEmails = allowedEmails ?? resolveAllowedCommitEmails({ cwd });
  if (!Array.isArray(resolvedAllowedEmails) || resolvedAllowedEmails.length === 0) {
    throw new Error('commit identity allowlist must be a non-empty array');
  }
  if (!Array.isArray(preservedImportHeads)) {
    throw new Error('preserved import heads must be an array');
  }

  const resolvedBase = git(['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const resolvedHead = git(['rev-parse', '--verify', `${head}^{commit}`], cwd);
  assertAncestor(resolvedBase, resolvedHead, cwd);

  if (resolvedAllowedEmails.some((email) => typeof email !== 'string' || email.length === 0)) {
    throw new Error('commit identity allowlist entries must be non-empty strings');
  }
  const allowedEmailSet = new Set(resolvedAllowedEmails.map(email => email.toLowerCase()));
  const commits = commitsInRange(resolvedBase, resolvedHead, cwd);
  const importCommits = preservedImportCommits(preservedImportHeads, resolvedHead, cwd);
  const violations = [];

  for (const sha of commits) {
    if (importCommits.has(sha)) continue;
    for (const [role, format] of [
      ['author', '%ae'],
      ['committer', '%ce'],
    ]) {
      const email = git(['show', '-s', `--format=${format}`, sha], cwd);
      if (!allowedEmailSet.has(email.toLowerCase())) {
        violations.push({ sha, email, role });
      }
    }
  }

  return {
    base: resolvedBase,
    head: resolvedHead,
    commitCount: commits.length,
    preservedImportCommitCount: commits.filter(sha => importCommits.has(sha)).length,
    violations,
  };
}

export function parseCommitIdentityArguments(args) {
  const options = { base: 'origin/main', head: 'HEAD' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--base' && flag !== '--head') {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

export function formatCommitIdentityViolations(violations) {
  return violations.map((violation) => {
    return `- ${violation.sha} rejected ${violation.role} email (address redacted)`;
  });
}

function main() {
  try {
    const options = parseCommitIdentityArguments(process.argv.slice(2));
    const result = checkCommitIdentityRange(options);
    if (result.violations.length > 0) {
      console.error('Commit identity check failed. Non-allowlisted commit identities found:');
      for (const line of formatCommitIdentityViolations(result.violations)) {
        console.error(line);
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      `Commit identity check passed for ${result.commitCount} commit(s) `
      + `in ${result.base}..${result.head}; `
      + `${result.preservedImportCommitCount} preserved import commit(s).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Commit identity check failed to complete: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
