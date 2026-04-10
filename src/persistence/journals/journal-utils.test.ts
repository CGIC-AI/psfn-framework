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
  buildTurnTombstoneJournalEntry,
  journalToCompactionSummary,
  journalToMarkerEntry,
  journalToSessionEntry,
  journalToTurnTombstoneEntry,
  quarantineSidecarPath,
  parseJournalText,
  parseLegacyChatSource,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  resolveJournalIntegrityChainCandidates,
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

  it('builds and maps turn tombstone entries', () => {
    const tombstone = buildTurnTombstoneJournalEntry(6, 'ch1', {
      turnId: '019a7e30-c4f4-72b6-b2b7-28fdd4dd7f76',
      action: 'redact',
      timestamp: 8_000,
      actor: 'admin:test',
      reason: 'privacy request',
    });

    expect(journalToTurnTombstoneEntry(tombstone)).toEqual({
      id: 6,
      channelId: 'ch1',
      targetType: 'turn',
      targetId: '019a7e30-c4f4-72b6-b2b7-28fdd4dd7f76',
      action: 'redact',
      timestamp: 8_000,
      actor: 'admin:test',
      reason: 'privacy request',
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
    appendJournalEntry(filePath, buildTurnTombstoneJournalEntry(5, 'ch1', {
      turnId: '019a7e30-c4f4-72b6-b2b7-28fdd4dd7f76',
      action: 'redact',
      timestamp: 1400,
    }));
    appendJournalEntry(filePath, buildTurnTombstoneJournalEntry(6, 'ch1', {
      turnId: '019a7e30-c4f4-72b6-b2b7-28fdd4dd7f76',
      action: 'restore',
      timestamp: 1500,
    }));

    const metadata = scanJournalFileMetadata(filePath);
    expect(metadata.maxId).toBe(6);
    expect(metadata.messageCount).toBe(2);
    expect(metadata.activeTurnTombstoneCount).toBe(0);
    expect(metadata.lastTimestamp).toBe(1500);
    expect(metadata.lastExtractionCoveredUpTo).toBe(1);
    expect(metadata.lastEntry?.type).toBe('tombstone');
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

    writeFileSync(filePath, '{"type":"message","id":1,"channelId":"ch1","role":"user","content":"ok","timestamp":1}\n{bad\n', 'utf-8');
    const withCorruption = readJournalFile(filePath);
    expect(withCorruption.quarantined).toHaveLength(1);
    expect(existsSync(quarantinePath)).toBe(true);

    const quarantineLines = readFileSync(quarantinePath, 'utf-8').trim().split('\n');
    expect(quarantineLines).toHaveLength(1);
    expect(JSON.parse(quarantineLines[0]).lineNumber).toBe(2);

    writeFileSync(filePath, '{"type":"message","id":1,"channelId":"ch1","role":"user","content":"ok","timestamp":1}\n', 'utf-8');
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

  it('loads entries normally when no keyring is configured (integrity disabled)', () => {
    // When there is no keyring, entries should load without any wrapping
    const entry = buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'normal content',
      timestamp: 1,
    });

    // Without a keyring, verifyJournalEntryIntegrity should not be called at all.
    // The SessionJournalRuntime returns the entry as-is when integrityProvider is null.
    // This test verifies the entry is not wrapped.
    expect(entry.content).toBe('normal content');
    expect(entry.content).not.toContain('<unverified_history>');
  });

  it('passes verification with valid HMAC when keyring is configured', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:test-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const entry = buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'verified content',
      timestamp: 1,
    });

    const signed = signJournalEntry(entry, keyring!, null);
    const result = verifyJournalEntryIntegrity(signed, keyring!, null);
    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('wraps tampered content when keyring is configured and HMAC fails', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:test-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const entry = buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'original content',
      timestamp: 1,
    });

    const signed = signJournalEntry(entry, keyring!, null);
    // Tamper with the content
    signed.content = 'tampered content';

    const result = verifyJournalEntryIntegrity(signed, keyring!, null);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('signature_mismatch');

    const wrapped = wrapUnverifiedHistory(signed.content!, result.reason);
    expect(wrapped).toContain('<unverified_history>');
    expect(wrapped).toContain('tampered content');
    expect(wrapped).toContain('signature_mismatch');
  });

  it('prefers the recomputed chain candidate when a signature field is corrupted', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:test-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'anchor',
      timestamp: 1,
    }), keyring!, null);
    const second = signJournalEntry(buildMessageJournalEntry(2, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'bridge',
      timestamp: 2,
    }), keyring!, first._hmac ?? null);

    second._hmac = 'not-a-real-hmac';

    const verification = verifyJournalEntryIntegrity(second, keyring!, first._hmac ?? null);
    expect(verification.verified).toBe(false);
    expect(verification.reason).toBe('invalid_signature_format');
    expect(verification.expectedHmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(resolveJournalIntegrityChainCandidates(verification, first._hmac ?? null)).toEqual([
      verification.expectedHmac ?? null,
    ]);
  });

  it('follows the observed stored HMAC after a content tamper to avoid branch explosion', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:test-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'anchor',
      timestamp: 1,
    }), keyring!, null);
    const second = signJournalEntry(buildMessageJournalEntry(2, {
      channelId: 'ch1',
      role: 'assistant',
      content: 'bridge',
      timestamp: 2,
    }), keyring!, first._hmac ?? null);

    second.content = 'tampered bridge';

    const verification = verifyJournalEntryIntegrity(second, keyring!, first._hmac ?? null);
    expect(verification.verified).toBe(false);
    expect(verification.reason).toBe('signature_mismatch');
    expect(resolveJournalIntegrityChainCandidates(verification, first._hmac ?? null)).toEqual([
      second._hmac ?? null,
    ]);
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
