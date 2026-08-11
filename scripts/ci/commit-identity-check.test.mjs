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
  resolveAllowedCommitEmails,
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
      preservedImportHeads: [],
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
      preservedImportHeads: [],
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
    assert.match(diagnostic, new RegExp(`${rejectedHead} rejected author email`));
    assert.match(diagnostic, new RegExp(`${rejectedHead} rejected committer email`));
    assert.doesNotMatch(diagnostic, /intruder|unauthorized-automation/);

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
      preservedImportHeads: [],
    });
    assert.deepEqual(caseVariantResult.violations, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loads maintainer identities from external environment and local Git config', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-identity-config-'));
  try {
    git(cwd, ['init', '--quiet']);
    git(cwd, ['config', '--add', 'delivery.allowedCommitEmail', 'local@example.invalid']);
    assert.deepEqual(
      resolveAllowedCommitEmails({
        cwd,
        env: { DELIVERY_ALLOWED_COMMIT_EMAILS: 'ci@example.invalid, second@example.invalid' },
      }).slice(-3),
      ['ci@example.invalid', 'second@example.invalid', 'local@example.invalid'],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('preserves source identities only within exact imported history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-identity-import-'));
  try {
    git(cwd, ['init', '--quiet']);
    const allowedEmails = ['maintainer@example.com'];
    const base = commit(cwd, 'base', allowedEmails[0]);
    const importedHead = commit(cwd, 'source history', 'source-author@example.com');
    const preservedImportHeads = [{ component: 'fixture', head: importedHead }];

    const importedResult = checkCommitIdentityRange({
      cwd,
      base,
      head: importedHead,
      allowedEmails,
      preservedImportHeads,
    });
    assert.deepEqual(importedResult.violations, []);
    assert.equal(importedResult.preservedImportCommitCount, 1);

    const ordinaryHead = commit(cwd, 'ordinary descendant', 'source-author@example.com');
    const descendantResult = checkCommitIdentityRange({
      cwd,
      base,
      head: ordinaryHead,
      allowedEmails,
      preservedImportHeads,
    });
    assert.deepEqual(
      descendantResult.violations.map(({ sha, email, role }) => ({ sha, email, role })),
      [
        { sha: ordinaryHead, email: 'source-author@example.com', role: 'author' },
        { sha: ordinaryHead, email: 'source-author@example.com', role: 'committer' },
      ],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
