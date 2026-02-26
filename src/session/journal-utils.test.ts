import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendJournalEntry,
  buildSessionHmacKeyring,
  buildCompactionJournalEntry,
  buildMessageJournalEntry,
  journalToCompactionSummary,
  journalToSessionEntry,
  quarantineSidecarPath,
  parseJournalText,
  readJournalFile,
  signJournalEntry,
  verifyJournalEntryIntegrity,
  wrapUnverifiedHistory,
} from './journal-utils.js';

describe('journal utils', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('parses journal text and computes maxId', () => {
    const raw = [
      JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'ch1',
        role: 'user',
        content: 'hello',
        timestamp: 1000,
      })),
      '',
      JSON.stringify(buildCompactionJournalEntry(4, 'ch1', 'summary', 3, 2000)),
      '',
    ].join('\n');

    const parsed = parseJournalText(raw);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.maxId).toBe(4);
  });

  it('skips malformed journal lines and records quarantine details', () => {
    const raw = [
      JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'ch1',
        role: 'user',
        content: 'before',
        timestamp: 1000,
      })),
      '{bad',
      JSON.stringify(buildMessageJournalEntry(3, {
        channelId: 'ch1',
        role: 'assistant',
        content: 'after',
        timestamp: 3000,
      })),
      '',
    ].join('\n');

    const parsed = parseJournalText(raw);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.maxId).toBe(3);
    expect(parsed.quarantined).toHaveLength(1);
    expect(parsed.quarantined[0]).toMatchObject({
      lineNumber: 2,
      raw: '{bad',
    });
  });

  it('builds and maps message journal entries with continuity metadata', () => {
    const journal = buildMessageJournalEntry(7, {
      channelId: 'api:session',
      role: 'assistant',
      content: 'response',
      timestamp: 1234,
      originChannelId: 'api:origin',
      channelVisibility: 'private',
    });

    const session = journalToSessionEntry(journal);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(7);
    expect(session?.originChannelId).toBe('api:origin');
    expect(session?.channelVisibility).toBe('private');
  });

  it('builds and maps compaction entries', () => {
    const journal = buildCompactionJournalEntry(3, 'ch1', 'sum', 2, 5000);
    const compaction = journalToCompactionSummary(journal);
    expect(compaction).toEqual({
      id: 3,
      channelId: 'ch1',
      summary: 'sum',
      coveredUpTo: 2,
      createdAt: 5000,
    });
  });

  it('appends and reads journal files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-journal-utils-'));
    dirs.push(dir);
    const filePath = join(dir, 'test.jsonl');

    appendJournalEntry(filePath, buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    }));
    appendJournalEntry(filePath, buildMessageJournalEntry(2, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'hi',
      timestamp: 2000,
    }));

    const parsed = readJournalFile(filePath);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.maxId).toBe(2);
    expect(parsed.quarantined).toEqual([]);
  });

  it('writes and clears quarantine sidecar files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-journal-utils-'));
    dirs.push(dir);
    const filePath = join(dir, 'broken.jsonl');
    const quarantinePath = quarantineSidecarPath(filePath);

    writeFileSync(filePath, '{"type":"message","id":1,"channelId":"ch1","timestamp":1}\n{bad\n', 'utf-8');
    const withCorruption = readJournalFile(filePath);
    expect(withCorruption.quarantined).toHaveLength(1);
    expect(existsSync(quarantinePath)).toBe(true);

    const quarantineLines = readFileSync(quarantinePath, 'utf-8').trim().split('\n');
    expect(quarantineLines).toHaveLength(1);
    expect(JSON.parse(quarantineLines[0]).lineNumber).toBe(2);

    writeFileSync(filePath, '{"type":"message","id":1,"channelId":"ch1","timestamp":1}\n', 'utf-8');
    const repaired = readJournalFile(filePath);
    expect(repaired.quarantined).toEqual([]);
    expect(existsSync(quarantinePath)).toBe(false);
  });

  it('builds keyrings and supports explicit active version', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1=old-secret,v2:new-secret',
      activeVersion: 'v2',
    });
    expect(keyring).not.toBeNull();
    expect(keyring?.activeVersion).toBe('v2');
    expect(Object.keys(keyring?.keys ?? {})).toEqual(['v1', 'v2']);
  });

  it('signs and verifies entries with HMAC chain state', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:alpha',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    }), keyring!, null);
    const firstVerification = verifyJournalEntryIntegrity(first, keyring!, null);
    expect(firstVerification.verified).toBe(true);

    const second = signJournalEntry(buildMessageJournalEntry(2, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'world',
      timestamp: 2,
    }), keyring!, first._hmac ?? null);
    const secondVerification = verifyJournalEntryIntegrity(second, keyring!, first._hmac ?? null);
    expect(secondVerification.verified).toBe(true);
  });

  it('flags tampered content and wraps unverified entries', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:alpha',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const signed = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'safe content',
      timestamp: 1,
    }), keyring!, null);
    signed.content = 'tampered content';

    const verification = verifyJournalEntryIntegrity(signed, keyring!, null);
    expect(verification.verified).toBe(false);
    expect(wrapUnverifiedHistory(signed.content ?? '', verification.reason))
      .toContain('<unverified_history>');
  });
});
