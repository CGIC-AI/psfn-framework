import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { runAttributionRepair } from './attribution-repair.js';

describe('runAttributionRepair', () => {
  it('corrects the derived turn-records mirror while leaving canonical L0 bytes untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-attribution-repair-'));
    try {
      const dataDir = join(root, 'data');
      const sessionsDir = join(dataDir, 'sessions');
      const turnRecordsDir = join(sessionsDir, '_turn_records');
      const backupDir = join(dataDir, 'repair-backups');
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(turnRecordsDir, { recursive: true });

      // Canonical L0 session chain with non-normalized attribution. It must not
      // be rewritten: the runtime normalizes attribution at read time.
      const canonicalPath = join(sessionsDir, '20260214_internal-reflection-whisper_scheduler_000001.jsonl');
      const canonicalBytes = `${JSON.stringify({
        type: 'message',
        id: 1,
        channelId: 'internal:reflection:whisper',
        role: 'user',
        content: 'heartbeat prompt',
        authorId: 'scheduler',
        authorName: 'Whisper',
        timestamp: 2,
      })}\n`;
      writeFileSync(canonicalPath, canonicalBytes, 'utf-8');

      // Derived turn-records mirror carrying the same stale attribution.
      const turnRecordPath = join(turnRecordsDir, 'internal%3Areflection%3Awhisper.jsonl');
      writeFileSync(
        turnRecordPath,
        `${JSON.stringify({
          schemaVersion: 1,
          turnId: '019cde45-5be1-7762-882f-6ee1cee35fc7',
          requestId: 'reflection-whisper-1773255613409',
          channelId: 'internal:reflection:whisper',
          channelType: 'terminal',
          startedAt: 10,
          completedAt: 20,
          status: 'completed',
          userMessage: {
            role: 'user',
            content: 'heartbeat prompt',
            timestamp: 10,
            authorId: 'scheduler',
            authorName: 'Whisper',
            sourceMessageId: 'reflection-whisper-1773255613409',
          },
          assistantMessage: {
            role: 'assistant',
            content: 'heartbeat reply',
            timestamp: 20,
          },
          toolCalls: [],
          extractedMemoryIds: [],
          concernDeltaRefs: [],
          contactDeltaRefs: [],
          versionPointers: { model: 'test/model' },
          provenanceRefs: [],
        })}\n`,
        'utf-8',
      );

      const report = runAttributionRepair({
        sessionsDir,
        backupDir,
        repoRoot: root,
      });

      // Derived mirror corrected.
      expect(report.turnRecords.modifiedFiles).toBe(1);
      const repairedTurnRecord = readFileSync(turnRecordPath, 'utf-8').trim();
      expect(repairedTurnRecord).toContain('"userMessage":{"role":"system"');
      expect(repairedTurnRecord).toContain('"authorId":"scheduler"');

      // Canonical L0 chain byte-identical to its pre-repair state.
      expect(readFileSync(canonicalPath, 'utf-8')).toBe(canonicalBytes);
      // No backup taken for the canonical chain (it was never touched).
      const canonicalBackup = join(backupDir, relative(root, canonicalPath));
      expect(existsSync(canonicalBackup)).toBe(false);

      // Derived channel index rebuilt from canon.
      expect(report.rebuiltChannelIndex).toBe(true);
      expect(existsSync(join(sessionsDir, '_channel_index.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves canonical chains untouched when the derived mirror needs no correction', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-attribution-noop-'));
    try {
      const sessionsDir = join(root, 'sessions');
      const backupDir = join(root, 'backups');
      mkdirSync(sessionsDir, { recursive: true });

      const canonicalPath = join(sessionsDir, '20260325_api-plain_user_000001.jsonl');
      const canonicalBytes = `${JSON.stringify({
        type: 'message',
        id: 1,
        channelId: 'api:plain',
        role: 'user',
        content: 'hello',
        authorId: 'partner',
        authorName: 'Partner',
        timestamp: 1_000,
      })}\n`;
      writeFileSync(canonicalPath, canonicalBytes, 'utf-8');

      const report = runAttributionRepair({
        sessionsDir,
        backupDir,
        repoRoot: root,
      });

      expect(report.turnRecords.modifiedFiles).toBe(0);
      expect(readFileSync(canonicalPath, 'utf-8')).toBe(canonicalBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
