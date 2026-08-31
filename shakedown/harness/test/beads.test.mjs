import assert from 'node:assert/strict';
import test from 'node:test';

import { isBeadsIssueId } from '../lib/beads.mjs';

test('accepts IDs emitted by both project-prefixed and embedded Beads databases', () => {
  assert.equal(isBeadsIssueId('PSFN-123'), true);
  assert.equal(isBeadsIssueId('bd_11111111-1111-4111-8111-111111111111-36q'), true);
  assert.equal(isBeadsIssueId('project.issue:child-1'), true);
});

test('rejects blank, shell-shaped, and non-string issue IDs', () => {
  assert.equal(isBeadsIssueId(''), false);
  assert.equal(isBeadsIssueId('--help'), false);
  assert.equal(isBeadsIssueId('issue id'), false);
  assert.equal(isBeadsIssueId('issue;rm'), false);
  assert.equal(isBeadsIssueId(null), false);
});
