#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Keep this list minimal. It contains the approved maintainer identity plus
// automation/hosted-git identities that are already present in repository
// history. Alternate human identities are intentionally not accepted.
export const ALLOWED_COMMIT_EMAILS = Object.freeze([
  'axAilotl@pm.me',
  'codex@local',
  'codex@local.invalid',
  'codex@localhost',
  'codex@openai.com',
  'noreply@github.com',
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

/**
 * @param {{
 *   base: string;
 *   head?: string;
 *   cwd?: string;
 *   allowedEmails?: readonly string[];
 * }} options
 */
export function checkCommitIdentityRange({
  base,
  head = 'HEAD',
  cwd = process.cwd(),
  allowedEmails = ALLOWED_COMMIT_EMAILS,
}) {
  if (!base) throw new Error('base ref is required');
  if (!head) throw new Error('head ref is required');
  if (!Array.isArray(allowedEmails) || allowedEmails.length === 0) {
    throw new Error('commit identity allowlist must be a non-empty array');
  }

  const resolvedBase = git(['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const resolvedHead = git(['rev-parse', '--verify', `${head}^{commit}`], cwd);
  assertAncestor(resolvedBase, resolvedHead, cwd);

  if (allowedEmails.some((email) => typeof email !== 'string' || email.length === 0)) {
    throw new Error('commit identity allowlist entries must be non-empty strings');
  }
  const allowedEmailSet = new Set(allowedEmails.map(email => email.toLowerCase()));
  const commits = commitsInRange(resolvedBase, resolvedHead, cwd);
  const violations = [];

  for (const sha of commits) {
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
    const email = violation.email || '<missing-email>';
    return `- ${violation.sha} ${email} (${violation.role})`;
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
      + `in ${result.base}..${result.head}.`,
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
