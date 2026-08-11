import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyForbiddenTrackedPath,
  evaluateHistoryHygiene,
  parseHistoryHygieneConfig,
} from './history-hygiene-check.mjs';

const config = Object.freeze({
  schemaVersion: 1,
  maxIssuesSnapshotBytes: 100,
  maxIssuesSnapshotVersionsPerGeneration: 3,
  rewriteGenerationMarker: 'config/history-rewrite-generation.json',
});

test('history-hygiene config validates every bounded value', () => {
  assert.deepEqual(parseHistoryHygieneConfig(JSON.stringify(config)), config);
  assert.throws(
    () => parseHistoryHygieneConfig(JSON.stringify({ ...config, maxIssuesSnapshotBytes: 0 })),
    /positive integer/u,
  );
});

test('classifies only the forbidden runtime-log and session-archive paths', () => {
  assert.equal(classifyForbiddenTrackedPath('.beads/daemon.log'), 'Beads runtime log');
  assert.equal(
    classifyForbiddenTrackedPath('working_docs/session-export.zip'),
    'session archive',
  );
  assert.equal(classifyForbiddenTrackedPath('src/session/archive.ts'), null);
  assert.equal(classifyForbiddenTrackedPath('working_docs/design.md'), null);
});

test('snapshot generation limits activate only after the rewrite marker exists', () => {
  assert.deepEqual(evaluateHistoryHygiene({
    config,
    trackedFiles: ['README.md'],
    issuesSnapshotBytes: 90,
    markerPresent: false,
    issuesSnapshotVersions: 99,
  }), []);

  assert.deepEqual(evaluateHistoryHygiene({
    config,
    trackedFiles: ['.beads/daemon.log', 'working_docs/session-export.zip'],
    issuesSnapshotBytes: 101,
    markerPresent: true,
    issuesSnapshotVersions: 4,
  }), [
    'Beads runtime log is tracked: .beads/daemon.log',
    'session archive is tracked: working_docs/session-export.zip',
    '.beads/issues.jsonl is 101 bytes; maximum is 100',
    '.beads/issues.jsonl has 4 versions since the rewrite generation; maximum is 3',
  ]);
});
