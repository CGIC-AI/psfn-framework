import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ALLOWED_COMMIT_EMAILS,
  checkCommitIdentityRange,
  formatCommitIdentityViolations,
} from './commit-identity-check.mjs';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd, message, authorEmail, committerEmail = authorEmail) {
  writeFileSync(join(cwd, 'tracked.txt'), `${message}\n`);
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '--quiet', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: committerEmail,
    },
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('commit identity range accepts allowlisted identities and reports every rejected role', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-identity-check-'));
  try {
    git(cwd, ['init', '--quiet']);
    const base = commit(cwd, 'base', 'base-fixture@example.com');
    assert.ok(ALLOWED_COMMIT_EMAILS.length > 0, 'production allowlist must not be empty');
    const allowedEmail = 'Allowed@example.com';
    const allowedEmails = [allowedEmail];

    const allowedHead = commit(cwd, 'allowed', allowedEmail);
    const allowedResult = checkCommitIdentityRange({
      cwd,
      base,
      head: allowedHead,
      allowedEmails,
    });
    assert.deepEqual(allowedResult.violations, []);

    const rejectedHead = commit(
      cwd,
      'rejected',
      'intruder@example.com',
      'unauthorized-automation@example.com',
    );
    const rejectedResult = checkCommitIdentityRange({
      cwd,
      base,
      head: rejectedHead,
      allowedEmails,
    });
    assert.deepEqual(
      rejectedResult.violations.map(({ sha, email, role }) => ({ sha, email, role })),
      [
        { sha: rejectedHead, email: 'intruder@example.com', role: 'author' },
        {
          sha: rejectedHead,
          email: 'unauthorized-automation@example.com',
          role: 'committer',
        },
      ],
    );
    const diagnostic = formatCommitIdentityViolations(rejectedResult.violations).join('\n');
    assert.match(diagnostic, new RegExp(`${rejectedHead} intruder@example\\.com`));
    assert.match(
      diagnostic,
      new RegExp(`${rejectedHead} unauthorized-automation@example\\.com`),
    );

    const caseVariantHead = commit(
      cwd,
      'case variant',
      'allowed@example.com',
      'ALLOWED@EXAMPLE.COM',
    );
    const caseVariantResult = checkCommitIdentityRange({
      cwd,
      base: rejectedHead,
      head: caseVariantHead,
      allowedEmails,
    });
    assert.deepEqual(caseVariantResult.violations, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
