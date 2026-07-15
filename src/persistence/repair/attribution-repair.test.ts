import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JournalEntry } from '../../core/session/types.js';
import {
  buildSessionHmacKeyring,
  signJournalEntry,
  verifyJournalEntryIntegrity,
} from '../journals/journal-utils.js';
import { makeRolledFilePath } from '../sessions/store/channel-filenames.js';
import { runAttributionRepair } from './attribution-repair.js';

describe('runAttributionRepair', () => {
  it('rewrites malformed intention and scheduler entries with proper system attribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-attribution-repair-'));
    try {
      const dataDir = join(root, 'data');
      const sessionsDir = join(dataDir, 'sessions');
      const turnRecordsDir = join(sessionsDir, '_turn_records');
      const continuityDir = join(dataDir, 'contacts', 'continuity');
      const reflectionsDir = join(dataDir, 'notes', 'reflections');
      const backupDir = join(dataDir, 'repair-backups');
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(turnRecordsDir, { recursive: true });
      mkdirSync(continuityDir, { recursive: true });
      mkdirSync(reflectionsDir, { recursive: true });

      const keyring = buildSessionHmacKeyring({ singleKey: 'repair-secret' });
      expect(keyring).not.toBeNull();

      const signedJournalPath = join(sessionsDir, '20260214_test_partner_000001.jsonl');
      const signedFirst = signJournalEntry({
        type: 'message',
        id: 1,
        channelId: '1313001762793197678',
        role: 'user',
        content: 'ghost message',
        authorId: '388908766306893854',
        authorName: 'Intention Appraisal',
        timestamp: 1,
        metadata: JSON.stringify({
          turn: {
            schemaVersion: 1,
            turnId: '019cd0c4-028f-74ea-bd0c-9b6489d76543',
            requestId: 'intention-follow-up:test',
            sourceMessageId: 'intention-follow-up:test',
            role: 'user',
          },
        }),
      }, keyring!, null);
      writeFileSync(signedJournalPath, `${JSON.stringify(signedFirst)}\n`, 'utf-8');

      const continuityPath = join(continuityDir, 'user_scheduler.jsonl');
      writeFileSync(
        continuityPath,
        `${JSON.stringify({
          type: 'message',
          id: 1,
          channelId: 'internal:reflection:whisper',
          role: 'user',
          content: 'heartbeat prompt',
          authorId: 'scheduler',
          authorName: 'Whisper',
          timestamp: 2,
        })}\n`,
        'utf-8',
      );

      const reflectionPath = join(reflectionsDir, '20260301_internal-reflection-daily-review_scheduler_000001.jsonl');
      writeFileSync(
        reflectionPath,
        `${JSON.stringify({
          type: 'message',
          id: 1,
          channelId: 'internal:reflection:daily-review',
          role: 'user',
          content: 'daily review prompt',
          authorId: 'scheduler',
          authorName: 'Daily Review',
          timestamp: 3,
        })}\n`,
        'utf-8',
      );

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
        continuityDir,
        reflectionsDir,
        backupDir,
        keyring,
        repoRoot: root,
      });

      expect(report.journal.modifiedFiles).toBe(3);
      expect(report.turnRecords.modifiedFiles).toBe(1);

      const repairedJournal = readFileSync(signedJournalPath, 'utf-8').trim();
      expect(repairedJournal).toContain('"role":"system"');
      expect(repairedJournal).toContain('\\"speakerRole\\":\\"system\\"');
      expect(repairedJournal).toContain('"authorId":"system:intention"');
      expect(repairedJournal).toContain('"authorName":"Intention Appraisal"');
      expect(repairedJournal).toContain('"role":"system"');

      const repairedContinuity = readFileSync(continuityPath, 'utf-8').trim();
      expect(repairedContinuity).toContain('"role":"system"');
      expect(repairedContinuity).toContain('"authorId":"scheduler"');

      const repairedReflection = readFileSync(reflectionPath, 'utf-8').trim();
      expect(repairedReflection).toContain('"role":"system"');

      const repairedTurnRecord = readFileSync(turnRecordPath, 'utf-8').trim();
      expect(repairedTurnRecord).toContain('"userMessage":{"role":"system"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-signs every rolled segment continuously when attribution changes an earlier entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-attribution-chain-repair-'));
    try {
      const sessionsDir = join(root, 'sessions');
      const continuityDir = join(root, 'continuity');
      const reflectionsDir = join(root, 'reflections');
      const backupDir = join(root, 'backups');
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(continuityDir, { recursive: true });
      mkdirSync(reflectionsDir, { recursive: true });
      const keyring = buildSessionHmacKeyring({ singleKey: 'repair-secret' });
      expect(keyring).not.toBeNull();
      const channelId = 'api:attribution-chain';
      const rootPath = join(sessionsDir, '20260325_api-attribution-chain_user_000001.jsonl');
      const segmentPath = makeRolledFilePath(rootPath, 2);
      const malformed = signJournalEntry({
        type: 'message',
        id: 1,
        channelId,
        role: 'user',
        content: '[Intention Appraisal] follow up',
        authorName: 'Intention Appraisal',
        timestamp: 1_000,
      }, keyring!, null);
      const segmentEntry = signJournalEntry({
        type: 'message',
        id: 2,
        channelId,
        role: 'assistant',
        content: 'segment reply',
        timestamp: 2_000,
      }, keyring!, malformed._hmac ?? null);
      writeFileSync(rootPath, `${JSON.stringify(malformed)}\n`, 'utf8');
      writeFileSync(segmentPath, `${JSON.stringify(segmentEntry)}\n`, 'utf8');

      const report = runAttributionRepair({
        sessionsDir,
        continuityDir,
        reflectionsDir,
        backupDir,
        keyring,
        repoRoot: root,
      });

      expect(report.journal.modifiedEntries).toBe(1);
      expect(report.journal.modifiedFiles).toBe(2);
      const repairedRoot = JSON.parse(readFileSync(rootPath, 'utf8').trim()) as JournalEntry;
      const repairedSegment = JSON.parse(readFileSync(segmentPath, 'utf8').trim()) as JournalEntry;
      expect(repairedRoot.role).toBe('system');
      expect(repairedRoot.authorId).toBe('system:intention');
      expect(verifyJournalEntryIntegrity(
        repairedSegment,
        keyring!,
        repairedRoot._hmac ?? null,
      ).verified).toBe(true);
      expect(verifyJournalEntryIntegrity(
        repairedSegment,
        keyring!,
        malformed._hmac ?? null,
      ).verified).toBe(false);

      const index = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8')) as {
        channels: Record<string, { filenames: string[] }>;
      };
      expect(index.channels[channelId].filenames).toEqual([
        basename(rootPath),
        basename(segmentPath),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
