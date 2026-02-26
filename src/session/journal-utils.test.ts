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
  buildExtractionMarkerJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildMessageJournalEntry,
  journalToCompactionSummary,
  journalToMarkerEntry,
  journalToSessionEntry,
  quarantineSidecarPath,
  parseJournalText,
  parseLegacyChatSource,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  scanJournalFileMetadata,
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

  it('builds and maps extraction + graceful shutdown marker entries', () => {
    const extractionMarker = buildExtractionMarkerJournalEntry(4, 'ch1', 7, 6_000);
    expect(journalToMarkerEntry(extractionMarker)).toEqual({
      id: 4,
      channelId: 'ch1',
      marker: 'extraction',
      timestamp: 6_000,
      coveredUpTo: 7,
    });

    const shutdownMarker = buildGracefulShutdownMarkerJournalEntry(5, 'ch1', 7_000);
    expect(journalToMarkerEntry(shutdownMarker)).toEqual({
      id: 5,
      channelId: 'ch1',
      marker: 'graceful_shutdown',
      timestamp: 7_000,
      coveredUpTo: undefined,
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

  it('reads first valid journal entry without full materialization', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-journal-utils-'));
    dirs.push(dir);
    const filePath = join(dir, 'first-entry.jsonl');

    writeFileSync(filePath, '{bad\n\n' + JSON.stringify(buildMessageJournalEntry(2, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'hi',
      timestamp: 2000,
    })) + '\n', 'utf-8');

    const first = readJournalFirstEntry(filePath);
    expect(first).not.toBeNull();
    expect(first?.channelId).toBe('ch1');
    expect(first?.id).toBe(2);
  });

  it('scans journal metadata with bounded memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-journal-utils-'));
    dirs.push(dir);
    const filePath = join(dir, 'meta.jsonl');

    appendJournalEntry(filePath, buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'a',
      timestamp: 1000,
    }));
    appendJournalEntry(filePath, buildExtractionMarkerJournalEntry(2, 'ch1', 1, 1100));
    appendJournalEntry(filePath, buildCompactionJournalEntry(3, 'ch1', 'sum', 1, 1200));
    appendJournalEntry(filePath, buildMessageJournalEntry(4, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'b',
      timestamp: 1300,
    }));

    const metadata = scanJournalFileMetadata(filePath);
    expect(metadata.maxId).toBe(4);
    expect(metadata.messageCount).toBe(2);
    expect(metadata.lastTimestamp).toBe(1300);
    expect(metadata.lastExtractionCoveredUpTo).toBe(1);
    expect(metadata.lastEntry?.type).toBe('message');
  });

  it('reads tail entries by message window and includes boundary entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-journal-utils-'));
    dirs.push(dir);
    const filePath = join(dir, 'tail.jsonl');

    appendJournalEntry(filePath, buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'm1',
      timestamp: 1000,
    }));
    appendJournalEntry(filePath, buildExtractionMarkerJournalEntry(2, 'ch1', 1, 1100));
    appendJournalEntry(filePath, buildMessageJournalEntry(3, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'm2',
      timestamp: 1200,
    }));
    appendJournalEntry(filePath, buildCompactionJournalEntry(4, 'ch1', 'sum', 2, 1300));
    appendJournalEntry(filePath, buildMessageJournalEntry(5, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'm3',
      timestamp: 1400,
    }));

    const tail = readJournalTailEntries(filePath, { messageLimit: 2 });
    expect(tail.truncated).toBe(true);
    expect(tail.entries.map(entry => entry.id)).toEqual([2, 3, 4, 5]);
    expect(tail.entries.filter(entry => entry.type === 'message').map(entry => entry.id)).toEqual([3, 5]);
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

  it('parses legacy chat JSON arrays and normalizes timestamps', () => {
    const parsed = parseLegacyChatSource(JSON.stringify([
      {
        role: 'user',
        text: 'Hello from legacy',
        timestamp: 1_700_000_000,
      },
      {
        role: 'assistant',
        content: 'Reply from import',
        createdAt: '2024-01-01T00:00:01.000Z',
      },
    ]));

    expect(parsed.format).toBe('json-array');
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      sourceIndex: 0,
      role: 'user',
      content: 'Hello from legacy',
      timestamp: 1_700_000_000_000,
    });
    expect(parsed.records[1]).toMatchObject({
      sourceIndex: 1,
      role: 'assistant',
      content: 'Reply from import',
      timestamp: Date.parse('2024-01-01T00:00:01.000Z'),
    });
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/i);
  });

  it('parses legacy chat JSONL and skips malformed or incomplete lines', () => {
    const raw = [
      '{"role":"human","message":"line one","time":"2024-01-01T00:00:00.000Z"}',
      '{bad json',
      '{"speaker":"assistant","content":"line two","timestamp":1704067201000}',
      '{"content":"missing timestamp"}',
    ].join('\n');
    const parsed = parseLegacyChatSource(raw);

    expect(parsed.format).toBe('jsonl');
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      sourceIndex: 0,
      role: 'user',
      content: 'line one',
      timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
    });
    expect(parsed.records[1]).toMatchObject({
      sourceIndex: 2,
      role: 'assistant',
      content: 'line two',
      timestamp: 1_704_067_201_000,
    });
  });
});
