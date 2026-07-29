import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../sessions/store.js';
import {
  buildExtractionMarkerJournalEntry,
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  signJournalEntry,
  verifyJournalEntryIntegrity,
} from '../journals/journal-utils.js';
import {
  runSessionIntegrityRepair,
  SESSION_INTEGRITY_REPAIR_AUDIT_EVENT,
  type SessionIntegrityRepairAuditSink,
} from './integrity-repair.js';
import type { JournalEntry } from '../../core/session/types.js';
import { makeRolledFilePath } from '../sessions/store/channel-filenames.js';

let rootsToDelete: string[] = [];

afterEach(() => {
  for (const root of rootsToDelete) {
    rmSync(root, { recursive: true, force: true });
  }
  rootsToDelete = [];
});

function createHarness(): {
  root: string;
  sessionsDir: string;
  backupDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'session-integrity-repair-'));
  const sessionsDir = join(root, 'sessions');
  const backupDir = join(root, 'backups');
  rootsToDelete.push(root);
  return { root, sessionsDir, backupDir };
}

function writeJournal(filePath: string, entries: readonly JournalEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

describe('runSessionIntegrityRepair', () => {
  it('signs fully unsigned legacy journal files so they load cleanly under integrity mode', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:repair-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-legacy_user_000001.jsonl');
    writeJournal(filePath, [
      buildMessageJournalEntry(1, {
        channelId: 'api:legacy',
        role: 'user',
        content: 'legacy hello',
        timestamp: 1000,
      }),
      buildMessageJournalEntry(2, {
        channelId: 'api:legacy',
        role: 'assistant',
        content: 'legacy hi',
        timestamp: 2000,
      }),
    ]);

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'test',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(2);

    const lines = readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(lines.every(line => typeof line._hmac === 'string' && typeof line._hmacKeyVersion === 'string')).toBe(true);

    const store = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
    });
    const entries = store.getRecent('api:legacy', 10);
    expect(entries.map(entry => entry.content)).toEqual(['legacy hello', 'legacy hi']);
    expect(entries.some(entry => entry.content.includes('<unverified_history>'))).toBe(false);
  });

  it('re-signs mixed legacy-prefix journals that later gained HMAC entries', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:repair-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-mixed_user_000002.jsonl');
    const unsignedPrefix: JournalEntry[] = [
      buildMessageJournalEntry(1, {
        channelId: 'api:mixed',
        role: 'user',
        content: 'unsigned one',
        timestamp: 1000,
      }),
      buildMessageJournalEntry(2, {
        channelId: 'api:mixed',
        role: 'assistant',
        content: 'unsigned two',
        timestamp: 2000,
      }),
    ];
    const signedStart = signJournalEntry(
      buildMessageJournalEntry(3, {
        channelId: 'api:mixed',
        role: 'user',
        content: 'signed three',
        timestamp: 3000,
      }),
      keyring!,
      null,
    );
    const signedMarker = signJournalEntry(
      buildExtractionMarkerJournalEntry(4, 'api:mixed', 3, 4000),
      keyring!,
      signedStart._hmac ?? null,
    );
    const signedTail = signJournalEntry(
      buildMessageJournalEntry(5, {
        channelId: 'api:mixed',
        role: 'assistant',
        content: 'signed five',
        timestamp: 5000,
      }),
      keyring!,
      signedMarker._hmac ?? null,
    );

    writeJournal(filePath, [...unsignedPrefix, signedStart, signedMarker, signedTail]);

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'test',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(2);

    const lines = readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(lines.every(line => typeof line._hmac === 'string' && typeof line._hmacKeyVersion === 'string')).toBe(true);

    const store = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
    });
    const entries = store.getRecent('api:mixed', 10);
    expect(entries.map(entry => entry.content)).toEqual([
      'unsigned one',
      'unsigned two',
      'signed three',
      'signed five',
    ]);
    expect(entries.some(entry => entry.content.includes('<unverified_history>'))).toBe(false);
  });

  it('re-signs tampered signed journals so they stop loading as unverified history', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:repair-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-tampered_user_000003.jsonl');
    const signedFirst = signJournalEntry(
      buildMessageJournalEntry(1, {
        channelId: 'api:tampered',
        role: 'user',
        content: 'original first',
        timestamp: 1000,
      }),
      keyring!,
      null,
    );
    const signedSecond = signJournalEntry(
      buildMessageJournalEntry(2, {
        channelId: 'api:tampered',
        role: 'assistant',
        content: 'original second',
        timestamp: 2000,
      }),
      keyring!,
      signedFirst._hmac ?? null,
    );

    const tamperedSecond = {
      ...signedSecond,
      content: 'tampered second',
    } satisfies JournalEntry;
    writeJournal(filePath, [signedFirst, tamperedSecond]);

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'test',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(1);

    const store = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
    });
    const entries = store.getRecent('api:tampered', 10);
    expect(entries.map(entry => entry.content)).toEqual(['original first', 'tampered second']);
    expect(entries.some(entry => entry.content.includes('<unverified_history>'))).toBe(false);
  });

  it('repairs only the corrupted signature entry when later image turns remain valid', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:repair-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-vision_user_000004.jsonl');
    const first = signJournalEntry(
      buildMessageJournalEntry(1, {
        channelId: 'api:vision',
        role: 'user',
        content: 'before the image turn',
        timestamp: 1000,
      }),
      keyring!,
      null,
    );
    const second = signJournalEntry(
      buildMessageJournalEntry(2, {
        channelId: 'api:vision',
        role: 'assistant',
        content: 'bridge entry',
        timestamp: 2000,
      }),
      keyring!,
      first._hmac ?? null,
    );
    const third = signJournalEntry(
      buildMessageJournalEntry(3, {
        channelId: 'api:vision',
        role: 'user',
        content: 'what is in the image?',
        timestamp: 3000,
      }),
      keyring!,
      second._hmac ?? null,
    );
    const fourth = signJournalEntry(
      buildMessageJournalEntry(4, {
        channelId: 'api:vision',
        role: 'assistant',
        content: 'Current image review: A catgirl sits on a server rack.',
        timestamp: 4000,
      }),
      keyring!,
      third._hmac ?? null,
    );

    writeJournal(filePath, [
      first,
      { ...second, _hmac: 'not-a-real-hmac' },
      third,
      fourth,
    ]);

    const beforeRepair = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
    });
    expect(beforeRepair.getRecent('api:vision', 10).map(entry => entry.content)).toEqual([
      'before the image turn',
      expect.stringContaining('<unverified_history>'),
      'what is in the image?',
      'Current image review: A catgirl sits on a server rack.',
    ]);

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'test',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(1);

    const store = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
    });
    const entries = store.getRecent('api:vision', 10);
    expect(entries.map(entry => entry.content)).toEqual([
      'before the image turn',
      'bridge entry',
      'what is in the image?',
      'Current image review: A catgirl sits on a server rack.',
    ]);
    expect(entries.some(entry => entry.content.includes('<unverified_history>'))).toBe(false);
  });

  it('repairs a rolled journal as one continuous HMAC chain and rebuilds its ordered index', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:repair-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const channelId = 'api:repair-chain';
    const rootPath = join(harness.sessionsDir, '20260325_api-repair-chain_user_000005.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId,
      role: 'user',
      content: 'root prompt',
      timestamp: 1_000,
    }), keyring!, null);
    const second = signJournalEntry(buildMessageJournalEntry(2, {
      channelId,
      role: 'assistant',
      content: 'root reply',
      timestamp: 2_000,
    }), keyring!, first._hmac ?? null);
    const brokenBoundary = signJournalEntry(buildMessageJournalEntry(3, {
      channelId,
      role: 'user',
      content: 'segment prompt',
      timestamp: 3_000,
    }), keyring!, null);
    writeJournal(rootPath, [first, second]);
    writeJournal(segmentPath, [brokenBoundary]);

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'test',
    });

    expect(report.journal.modifiedFiles).toBe(2);
    expect(report.journal.modifiedEntries).toBeGreaterThanOrEqual(1);
    const repairedRoot = readFileSync(rootPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    const repairedSegment = readFileSync(segmentPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(verifyJournalEntryIntegrity(
      repairedSegment[0]!,
      keyring!,
      repairedRoot.at(-1)?._hmac ?? null,
    ).verified).toBe(true);
    expect(verifyJournalEntryIntegrity(repairedSegment[0]!, keyring!, null).verified).toBe(false);

    const index = JSON.parse(
      readFileSync(join(harness.sessionsDir, '_channel_index.json'), 'utf8'),
    ) as { version: number; channels: Record<string, { filenames: string[] }> };
    expect(index.version).toBe(5);
    expect(index.channels[channelId].filenames).toEqual([
      basename(rootPath),
      basename(segmentPath),
    ]);
    const store = new SessionStore(harness.sessionsDir, { integrityKeyring: keyring });
    expect(store.getRecent(channelId, 10).map(entry => entry.content)).toEqual([
      'root prompt',
      'root reply',
      'segment prompt',
    ]);
  });
});

function createAuditSpy(): SessionIntegrityRepairAuditSink & {
  records: Array<{ event: string; details: Record<string, unknown> }>;
} {
  const records: Array<{ event: string; details: Record<string, unknown> }> = [];
  return {
    records,
    append(event, details): void {
      records.push({ event, details });
    },
  };
}

describe('runSessionIntegrityRepair audit + usage record (psfn-framework-31n1i)', () => {
  it('emits one durable, content-free record with counts, channels, reason, and outcome on success', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-legacy_user_000001.jsonl');
    writeJournal(filePath, [
      buildMessageJournalEntry(1, { channelId: 'api:legacy', role: 'user', content: 'legacy hello', timestamp: 1000 }),
      buildMessageJournalEntry(2, { channelId: 'api:legacy', role: 'assistant', content: 'legacy hi', timestamp: 2000 }),
    ]);

    const audit = createAuditSpy();
    runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'operator re-sign after hotfix churn',
      audit,
    });

    expect(audit.records).toHaveLength(1);
    const [record] = audit.records;
    expect(record.event).toBe(SESSION_INTEGRITY_REPAIR_AUDIT_EVENT);
    expect(record.details).toMatchObject({
      reason: 'operator re-sign after hotfix churn',
      outcome: 'completed',
      scannedFiles: 1,
      modifiedFiles: 1,
      modifiedEntries: 2,
      channelIds: ['api:legacy'],
      rebuiltChannelIndex: true,
    });
    // Content-free: the record never carries message text.
    const serialized = JSON.stringify(record.details);
    expect(serialized).not.toContain('legacy hello');
    expect(serialized).not.toContain('legacy hi');
  });

  it('fails closed without an operator reason and records nothing', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();
    const audit = createAuditSpy();

    expect(() => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: '   ',
      audit,
    })).toThrow(/non-empty operator reason/u);
    expect(audit.records).toHaveLength(0);
  });

  it('records the attempt and failed outcome when a later chain aborts a partially-applied run, then rethrows', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    // Chain "alpha" sorts first and re-signs cleanly; chain "bravo" carries a
    // malformed line that aborts the run after alpha was already rewritten.
    const alphaPath = join(harness.sessionsDir, '20260325_api-alpha_user_000001.jsonl');
    writeJournal(alphaPath, [
      buildMessageJournalEntry(1, { channelId: 'api:alpha', role: 'user', content: 'alpha one', timestamp: 1000 }),
      buildMessageJournalEntry(2, { channelId: 'api:alpha', role: 'assistant', content: 'alpha two', timestamp: 2000 }),
    ]);
    const bravoPath = join(harness.sessionsDir, '20260325_api-bravo_user_000002.jsonl');
    mkdirSync(dirname(bravoPath), { recursive: true });
    const bravoValid = buildMessageJournalEntry(1, {
      channelId: 'api:bravo', role: 'user', content: 'bravo one', timestamp: 1000,
    });
    writeFileSync(bravoPath, `${JSON.stringify(bravoValid)}\nNOT_VALID_JSON\n`, 'utf8');

    const audit = createAuditSpy();
    expect(() => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'operator re-sign after hotfix churn',
      audit,
    })).toThrow(/malformed journal file/u);

    expect(audit.records).toHaveLength(1);
    const [record] = audit.records;
    expect(record.event).toBe(SESSION_INTEGRITY_REPAIR_AUDIT_EVENT);
    expect(record.details.outcome).toBe('failed');
    expect(typeof record.details.errorMessage).toBe('string');
    expect(record.details.rebuiltChannelIndex).toBe(false);
    // Partial progress is captured: alpha was already re-signed before bravo aborted.
    expect(record.details.modifiedEntries).toBeGreaterThan(0);
    expect(record.details.channelIds).toEqual(
      expect.arrayContaining(['api:alpha', 'api:bravo']),
    );
    expect(record.details.reason).toBe('operator re-sign after hotfix churn');
  });

  it('emits no record when no audit sink is wired (repair behavior unchanged)', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();
    const filePath = join(harness.sessionsDir, '20260325_api-plain_user_000001.jsonl');
    writeJournal(filePath, [
      buildMessageJournalEntry(1, { channelId: 'api:plain', role: 'user', content: 'plain hello', timestamp: 1000 }),
    ]);

    // No audit sink: the run still succeeds and re-signs exactly as before.
    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      repoRoot: harness.root,
      reason: 'no-sink run',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(1);
    expect(report.rebuiltChannelIndex).toBe(true);
  });
});
