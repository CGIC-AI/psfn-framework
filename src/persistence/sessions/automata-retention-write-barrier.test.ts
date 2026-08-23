import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './store.js';
import { FilesystemAutomataRetentionWriteBarrier } from './automata-retention-write-barrier.js';

describe('FilesystemAutomataRetentionWriteBarrier', () => {
  it('survives restart and rejects a canonical journal writer after sealing', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-automata-write-barrier-'));
    const barrier = new FilesystemAutomataRetentionWriteBarrier(sessionsDir, 'companion-a');
    const store = new SessionStore(sessionsDir, { automataRetentionWriteBarrier: barrier });
    store.append({
      channelId: 'worker:one',
      role: 'user',
      content: 'pre-seal content',
      timestamp: 1,
    });

    try {
      barrier.seal({
        companionId: 'companion-a',
        sessionId: 'worker:one',
        runId: 'run-one',
        targetRevision: 'revision-one',
        preserveReferences: [],
      }, {
        classification: {
          schemaVersion: 1,
          companionId: 'companion-a',
          sessionId: 'worker:one',
          ownership: 'automata',
          runId: 'run-one',
          automatonClass: 'subagent.bounded',
          workerGeneration: 1,
          classifiedAtMs: 1,
          retentionDeadlineMs: 2,
        },
        channelId: 'worker:one',
        tailChannelKey: 'worker:one',
        turnRecordChannelId: 'worker:one',
        activeJournalFilename: 'worker_one.jsonl',
        rolledJournalFilenames: [],
      });

      const restartedBarrier = new FilesystemAutomataRetentionWriteBarrier(
        sessionsDir,
        'companion-a',
      );
      const restarted = new SessionStore(sessionsDir, {
        automataRetentionWriteBarrier: restartedBarrier,
      });
      expect(() => restarted.append({
        channelId: 'worker:one',
        role: 'assistant',
        content: 'must not resurrect',
        timestamp: 2,
      })).toThrow('permanently sealed');
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('rejects cross-companion seal attempts without creating a marker', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-automata-write-barrier-'));
    const barrier = new FilesystemAutomataRetentionWriteBarrier(sessionsDir, 'companion-a');
    try {
      expect(() => barrier.seal({
        companionId: 'companion-b',
        sessionId: 'worker:one',
        runId: 'run-one',
        targetRevision: 'revision-one',
        preserveReferences: [],
      }, {
        classification: {
          schemaVersion: 1,
          companionId: 'companion-b',
          sessionId: 'worker:one',
          ownership: 'automata',
          runId: 'run-one',
          automatonClass: 'subagent.bounded',
          workerGeneration: 1,
          classifiedAtMs: 1,
          retentionDeadlineMs: 2,
        },
        channelId: 'worker:one',
        tailChannelKey: 'worker:one',
        turnRecordChannelId: 'worker:one',
        activeJournalFilename: 'worker_one.jsonl',
        rolledJournalFilenames: [],
      })).toThrow('companion scope mismatch');
      expect(() => barrier.assertWritable(['worker:one'])).not.toThrow();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('releases a completed maintenance seal so the canonical test session can be reused', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-automata-write-barrier-'));
    const barrier = new FilesystemAutomataRetentionWriteBarrier(sessionsDir, 'companion-a');
    const purgeInput = {
      companionId: 'companion-a',
      sessionId: 'api:testing-harness',
      runId: 'run-one',
      targetRevision: 'revision-one',
      preserveReferences: [],
    };
    const target = {
      classification: {
        schemaVersion: 1 as const,
        companionId: 'companion-a',
        sessionId: 'api:testing-harness',
        ownership: 'testing_harness' as const,
        runId: 'run-one',
        manifestId: 'manifest-one',
        classifiedAtMs: 1,
      },
      channelId: 'api:testing-harness',
      tailChannelKey: 'api:testing-harness',
      turnRecordChannelId: 'api:testing-harness',
      activeJournalFilename: 'api_testing-harness.jsonl',
      rolledJournalFilenames: [],
    };
    try {
      barrier.seal(purgeInput, target);
      expect(() => barrier.assertWritable([purgeInput.sessionId])).toThrow('sealed');
      barrier.unseal(purgeInput, target);
      expect(() => barrier.assertWritable([purgeInput.sessionId])).not.toThrow();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
