import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { pendingJournalChainRewriteManifestPath } from '../journals/journal/chain-transaction.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import {
  resolveJournalBackupPath,
  rewriteJournalChainUnderLock,
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

  it('quarantines malformed rows durably while preserving every valid entry and its original sealing', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-framed_user_000006.jsonl');
    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'api:framed', role: 'user', content: 'framed one', timestamp: 1000,
    }), keyring!, null);
    const second = signJournalEntry(buildMessageJournalEntry(2, {
      channelId: 'api:framed', role: 'assistant', content: 'framed two', timestamp: 2000,
    }), keyring!, first._hmac ?? null);
    const originalLines = `${JSON.stringify(first)}\n{not-json}\n${JSON.stringify(second)}\n`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, originalLines, 'utf8');

    const audit = createAuditSpy();
    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      reason: 'psfn-framework-8xc4k handoff-recovery disposition',
      audit,
    });

    // Quarantine-only: no entry needed re-signing, so no valid byte changed.
    expect(report.journal.quarantinedRows).toBe(1);
    expect(report.journal.modifiedEntries).toBe(0);
    expect(report.journal.modifiedFiles).toBe(1);
    expect(readFileSync(filePath, 'utf8')).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );

    // Durable two-phase receipt: one prepared line per quarantined row plus a
    // completed terminal line, all content-free (the full pre-repair bytes
    // live in the timestamped backup copy).
    const receiptsPath = join(harness.backupDir, 'quarantine-receipts.jsonl');
    const receipts = readFileSync(receiptsPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      phase: 'prepared',
      file: '20260325_api-framed_user_000006.jsonl',
      backupFile: '20260325_api-framed_user_000006.jsonl',
      lineNumber: 2,
      rawLength: '{not-json}'.length,
    });
    expect(typeof receipts[0]!.reason).toBe('string');
    expect(receipts[1]).toMatchObject({
      dispositionId: receipts[0]!.dispositionId,
      phase: 'completed',
      rowCount: 1,
    });
    expect(JSON.stringify(receipts)).not.toContain('framed one');
    expect(JSON.stringify(receipts)).not.toContain('{not-json}');
    const backupCopy = readFileSync(
      join(harness.backupDir, '20260325_api-framed_user_000006.jsonl'),
      'utf8',
    );
    expect(backupCopy).toBe(originalLines);

    // The run-level audit event carries the durable, content-free disposition.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.details).toMatchObject({
      outcome: 'completed',
      quarantinedRows: 1,
      modifiedEntries: 0,
    });

    // The chain still verifies and loads cleanly under integrity mode.
    const store = new SessionStore(harness.sessionsDir, { integrityKeyring: keyring });
    expect(store.getRecent('api:framed', 10).map(entry => entry.content)).toEqual([
      'framed one',
      'framed two',
    ]);
  });

  it('combines malformed-row quarantine with re-signing in one pass', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-mixedframe_user_000007.jsonl');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, [
      JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'api:mixedframe', role: 'user', content: 'mixed one', timestamp: 1000,
      })),
      '{corrupt}',
      JSON.stringify(buildMessageJournalEntry(2, {
        channelId: 'api:mixedframe', role: 'assistant', content: 'mixed two', timestamp: 2000,
      })),
      '',
    ].join('\n'), 'utf8');

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      reason: 'test',
    });

    expect(report.journal.quarantinedRows).toBe(1);
    expect(report.journal.modifiedEntries).toBe(2);
    const store = new SessionStore(harness.sessionsDir, { integrityKeyring: keyring });
    expect(store.getRecent('api:mixedframe', 10).map(entry => entry.content)).toEqual([
      'mixed one',
      'mixed two',
    ]);
  });

  it('is idempotent: a second run finds no corruption and rewrites nothing', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    const filePath = join(harness.sessionsDir, '20260325_api-idem_user_000008.jsonl');
    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'api:idem', role: 'user', content: 'idem one', timestamp: 1000,
    }), keyring!, null);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(first)}\nnot json at all\n`, 'utf8');

    const run = () => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      reason: 'test',
    });

    const firstReport = run();
    expect(firstReport.journal.quarantinedRows).toBe(1);
    const afterFirst = readFileSync(filePath, 'utf8');

    const secondReport = run();
    expect(secondReport.journal).toMatchObject({
      modifiedFiles: 0,
      modifiedEntries: 0,
      quarantinedRows: 0,
    });
    expect(readFileSync(filePath, 'utf8')).toBe(afterFirst);
    // The receipt ledger is append-only per disposition, not per run: exactly
    // one prepared row plus its completed terminal line after both runs.
    const receipts = readFileSync(join(harness.backupDir, 'quarantine-receipts.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { phase: string });
    expect(receipts.map(record => record.phase)).toEqual(['prepared', 'completed']);
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
      reason: '   ',
      audit,
    })).toThrow(/non-empty operator reason/u);
    expect(audit.records).toHaveLength(0);
  });

  it('records the attempt and failed outcome when discovery refuses an unsafe chain layout, then rethrows', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    expect(keyring).not.toBeNull();

    // Chain "alpha" is clean; the "bravo" file carries only a malformed row, so
    // no channel id is recoverable and discovery classifies it as an incomplete
    // chain. The refusal precedes any rewrite: fail closed, nothing modified.
    const alphaPath = join(harness.sessionsDir, '20260325_api-alpha_user_000001.jsonl');
    writeJournal(alphaPath, [
      buildMessageJournalEntry(1, { channelId: 'api:alpha', role: 'user', content: 'alpha one', timestamp: 1000 }),
      buildMessageJournalEntry(2, { channelId: 'api:alpha', role: 'assistant', content: 'alpha two', timestamp: 2000 }),
    ]);
    const bravoPath = join(harness.sessionsDir, '20260325_api-bravo_user_000002.jsonl');
    mkdirSync(dirname(bravoPath), { recursive: true });
    writeFileSync(bravoPath, 'NOT_VALID_JSON\n', 'utf8');

    const audit = createAuditSpy();
    expect(() => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      reason: 'operator re-sign after hotfix churn',
      audit,
    })).toThrow(/Refusing integrity repair with incomplete L0 chains/u);

    expect(audit.records).toHaveLength(1);
    const [record] = audit.records;
    expect(record.event).toBe(SESSION_INTEGRITY_REPAIR_AUDIT_EVENT);
    expect(record.details.outcome).toBe('failed');
    expect(typeof record.details.errorMessage).toBe('string');
    expect(record.details.rebuiltChannelIndex).toBe(false);
    expect(record.details.modifiedEntries).toBe(0);
    expect(record.details.quarantinedRows).toBe(0);
    expect(record.details.reason).toBe('operator re-sign after hotfix churn');
    // Fail closed means exactly that: alpha was not rewritten either.
    expect(readFileSync(alphaPath, 'utf8')).not.toContain('_hmac');
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
      reason: 'no-sink run',
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(1);
    expect(report.rebuiltChannelIndex).toBe(true);
  });
});

describe('quarantine disposition durability + containment (psfn-framework-8xc4k review)', () => {
  function readReceipts(backupDir: string): Array<Record<string, unknown>> {
    return readFileSync(join(backupDir, 'quarantine-receipts.jsonl'), 'utf8')
      .trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  function writeMalformedJournal(filePath: string, channelId: string): {
    first: JournalEntry;
    originalLines: string;
  } {
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    const first = signJournalEntry(buildMessageJournalEntry(1, {
      channelId, role: 'user', content: `${channelId} content`, timestamp: 1000,
    }), keyring!, null);
    const originalLines = `${JSON.stringify(first)}\n{not-json}\n`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, originalLines, 'utf8');
    return { first, originalLines };
  }

  it('keeps every backup inside backupDir when the sessions root lives outside the checkout', () => {
    // Neither tree is under process.cwd(): the pre-review repoRoot-relative
    // naming escaped backupDir through `..` segments in this exact layout.
    const dataRoot = mkdtempSync(join(tmpdir(), 'session-integrity-data-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'session-integrity-backup-'));
    rootsToDelete.push(dataRoot, backupRoot);
    const sessionsDir = join(dataRoot, 'state', 'sessions');
    const backupDir = join(backupRoot, 'repair-backups');
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });

    const filePath = join(sessionsDir, '20260325_api-outside_user_000001.jsonl');
    writeMalformedJournal(filePath, 'api:outside');

    const report = runSessionIntegrityRepair({
      sessionsDir,
      backupDir,
      keyring: keyring!,
      reason: 'outside-root layout',
    });
    expect(report.journal.quarantinedRows).toBe(1);

    const backupPath = join(backupDir, '20260325_api-outside_user_000001.jsonl');
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toContain('{not-json}');
    // Nothing may have been written outside the backup namespace.
    expect(readFileSync(filePath, 'utf8')).not.toContain('{not-json}');
    const receipts = readReceipts(backupDir);
    expect(receipts.map(record => record.phase)).toEqual(['prepared', 'completed']);
    for (const record of receipts) {
      for (const value of Object.values(record)) {
        if (typeof value !== 'string') continue;
        expect(value.includes('..')).toBe(false);
        expect(value.startsWith('/')).toBe(false);
      }
    }
  });

  it('fails closed on backup paths outside the sessions root or escaping the backup directory', () => {
    const base = join(tmpdir(), 'session-integrity-containment');
    expect(() => resolveJournalBackupPath(
      join(base, 'backups'),
      join(base, 'sessions'),
      join(base, 'elsewhere', '20260325_api-x_user_000001.jsonl'),
    )).toThrow(/outside the sessions data root/u);
    expect(() => resolveJournalBackupPath(
      join(base, 'backups'),
      join(base, 'sessions'),
      join(base, 'sessions', '..', '..', 'escape.jsonl'),
    )).toThrow(/outside the sessions data root/u);
    // The sessions root itself is not a file inside it.
    expect(() => resolveJournalBackupPath(
      join(base, 'backups'),
      join(base, 'sessions'),
      join(base, 'sessions'),
    )).toThrow(/outside the sessions data root/u);
    expect(resolveJournalBackupPath(
      join(base, 'backups'),
      join(base, 'sessions'),
      join(base, 'sessions', '20260325_api-x_user_000001.jsonl'),
    )).toBe(join(base, 'backups', '20260325_api-x_user_000001.jsonl'));
  });

  it('fails before any destructive step when the backup directory is not writable', () => {
    if (process.getuid?.() === 0) return; // chmod cannot fence root
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    const filePath = join(harness.sessionsDir, '20260325_api-nowrite_user_000001.jsonl');
    const { originalLines } = writeMalformedJournal(filePath, 'api:nowrite');
    mkdirSync(harness.backupDir, { recursive: true });
    chmodSync(harness.backupDir, 0o555);
    try {
      expect(() => runSessionIntegrityRepair({
        sessionsDir: harness.sessionsDir,
        backupDir: harness.backupDir,
        keyring: keyring!,
        reason: 'unwritable backup dir',
      })).toThrow();
    } finally {
      chmodSync(harness.backupDir, 0o755);
    }
    // Nothing destructive happened: the malformed row is still in place and no
    // receipt claims a disposition.
    expect(readFileSync(filePath, 'utf8')).toBe(originalLines);
    expect(existsSync(join(harness.backupDir, 'quarantine-receipts.jsonl'))).toBe(false);
  });

  it('leaves a truthful prepared+aborted ledger and the raw backup when the rewrite aborts', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    const filePath = join(harness.sessionsDir, '20260325_api-abort_user_000001.jsonl');
    const { originalLines } = writeMalformedJournal(filePath, 'api:abort');
    const failingArchivePort = {
      openArchive: (channelId: string, archivePath: string) => ({ channelId, filePath: archivePath }),
      rewriteJournalChain: () => {
        throw new Error('injected rewrite failure');
      },
    } as unknown as ReturnType<typeof createFilesystemSessionArchivePort>;

    expect(() => rewriteJournalChainUnderLock(
      [filePath],
      keyring!,
      harness.backupDir,
      harness.sessionsDir,
      failingArchivePort,
      () => {},
    )).toThrow('injected rewrite failure');

    // Ordering guarantee: the destructive commit never ran, the malformed row
    // is still in place, and both the raw backup and the content-free
    // disposition record were already durable.
    expect(readFileSync(filePath, 'utf8')).toBe(originalLines);
    expect(readFileSync(
      join(harness.backupDir, '20260325_api-abort_user_000001.jsonl'),
      'utf8',
    )).toBe(originalLines);
    const receipts = readReceipts(harness.backupDir);
    expect(receipts.map(record => record.phase)).toEqual(['prepared', 'aborted']);
    expect(receipts[1]).toMatchObject({
      dispositionId: receipts[0]!.dispositionId,
      rowCount: 1,
      errorMessage: 'injected rewrite failure',
    });
    expect(JSON.stringify(receipts)).not.toContain('{not-json}');
    expect(JSON.stringify(receipts)).not.toContain('api:abort content');
  });

  it('recovers a pending prepared-phase rewrite before dispositioning, then completes', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:repair-key', activeVersion: 'v1' });
    const filePath = join(harness.sessionsDir, '20260325_api-crash_user_000001.jsonl');
    const { first, originalLines } = writeMalformedJournal(filePath, 'api:crash');

    // Simulate a process killed after the transaction's prepared phase: the
    // durable backup holds the original bytes and the target was left
    // half-installed (malformed row already dropped), manifest still pending.
    const transactionId = 'repair-crash-test';
    const backupPath = `${filePath}.${transactionId}.backup`;
    copyFileSync(filePath, backupPath);
    writeFileSync(filePath, `${JSON.stringify(first)}\n`, 'utf8');
    writeFileSync(pendingJournalChainRewriteManifestPath(filePath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'prepared',
      rootPath: filePath,
      files: [{
        targetPath: filePath,
        stagedPath: `${filePath}.${transactionId}.staged`,
        backupPath,
      }],
    }), 'utf8');

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring: keyring!,
      reason: 'post-crash disposition',
    });

    // Rollback restored the original (malformed row included), then the run
    // dispositioned it exactly once.
    expect(report.journal.quarantinedRows).toBe(1);
    expect(readFileSync(filePath, 'utf8')).not.toContain('{not-json}');
    expect(readFileSync(filePath, 'utf8')).toContain('api:crash content');
    expect(readFileSync(
      join(harness.backupDir, '20260325_api-crash_user_000001.jsonl'),
      'utf8',
    )).toBe(originalLines);
    const receipts = readReceipts(harness.backupDir);
    expect(receipts.map(record => record.phase)).toEqual(['prepared', 'completed']);
  });
});
