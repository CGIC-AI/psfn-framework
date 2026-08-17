import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  signJournalEntry,
} from '../journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { fingerprintJournalArchiveGeneration } from '../sessions/store/journal-chain-runtime.js';
import { runSessionIntegrityRepair } from './integrity-repair.js';

const rootsToDelete: string[] = [];

afterEach(() => {
  for (const root of rootsToDelete) {
    rmSync(root, { recursive: true, force: true });
  }
  rootsToDelete.length = 0;
});

function createHarness(): {
  backupDir: string;
  sessionsDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'session-integrity-targeting-'));
  rootsToDelete.push(root);
  return {
    backupDir: join(root, 'backups'),
    sessionsDir: join(root, 'sessions'),
  };
}

function writeMalformedJournal(
  sessionsDir: string,
  filename: string,
  channelId: string,
  keyring: NonNullable<ReturnType<typeof buildSessionHmacKeyring>>,
): string {
  const filePath = join(sessionsDir, filename);
  const entry = signJournalEntry(buildMessageJournalEntry(1, {
    channelId,
    role: 'user',
    content: `${channelId} retained history`,
    timestamp: 1_000,
  }), keyring, null);
  const raw = `${JSON.stringify(entry)}\n{not-json}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, raw, 'utf8');
  return raw;
}

describe('targeted session integrity repair', () => {
  it('backs up and repairs only explicitly selected recovery owners', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:targeted-repair-key',
      activeVersion: 'v1',
    })!;
    const selectedChannel = 'api:selected-recovery-owner';
    const untouchedChannel = 'api:untouched-recovery-owner';
    const selectedFilename = '20260807_api-selected-recovery-owner_user_000001.jsonl';
    const untouchedFilename = '20260807_api-untouched-recovery-owner_user_000002.jsonl';
    writeMalformedJournal(
      harness.sessionsDir,
      selectedFilename,
      selectedChannel,
      keyring,
    );
    const untouchedBefore = writeMalformedJournal(
      harness.sessionsDir,
      untouchedFilename,
      untouchedChannel,
      keyring,
    );

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring,
      reason: 'target one background-work recovery owner',
      targetChannelIds: [selectedChannel],
    });

    expect(report.journal).toMatchObject({
      scannedFiles: 1,
      modifiedFiles: 1,
      modifiedEntries: 0,
      quarantinedRows: 1,
    });
    expect(readFileSync(join(harness.sessionsDir, selectedFilename), 'utf8'))
      .not.toContain('{not-json}');
    expect(readFileSync(join(harness.sessionsDir, untouchedFilename), 'utf8'))
      .toBe(untouchedBefore);
    expect(readFileSync(join(harness.backupDir, selectedFilename), 'utf8'))
      .toContain('{not-json}');
    expect(existsSync(join(harness.backupDir, untouchedFilename))).toBe(false);
    const receipts = readFileSync(
      join(harness.backupDir, 'quarantine-receipts.jsonl'),
      'utf8',
    );
    expect(receipts).toContain(selectedFilename);
    expect(receipts).not.toContain(untouchedFilename);
  });

  it('fails closed when an explicit target set is empty or unresolved', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:targeted-repair-key',
      activeVersion: 'v1',
    })!;
    const filename = '20260807_api-known-recovery-owner_user_000001.jsonl';
    const original = writeMalformedJournal(
      harness.sessionsDir,
      filename,
      'api:known-recovery-owner',
      keyring,
    );

    expect(() => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring,
      reason: 'empty target must not widen to every owner',
      targetChannelIds: [],
    })).toThrow(/target channel/iu);
    expect(() => runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring,
      reason: 'unknown target must not widen to every owner',
      targetChannelIds: ['api:missing-recovery-owner'],
    })).toThrow(/missing-recovery-owner/u);

    expect(readFileSync(join(harness.sessionsDir, filename), 'utf8')).toBe(original);
    expect(existsSync(join(harness.backupDir, filename))).toBe(false);
  });

  it('repairs only one exact chain when a physical channel has sibling sessions', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:exact-chain-key',
      activeVersion: 'v1',
    })!;
    const channelId = 'api:shared-exact-owner';
    const selectedFilename = '20260817_api-shared-exact-owner_one_000001.jsonl';
    const siblingFilename = '20260817_api-shared-exact-owner_two_000002.jsonl';
    writeMalformedJournal(harness.sessionsDir, selectedFilename, channelId, keyring);
    const siblingBytes = writeMalformedJournal(
      harness.sessionsDir,
      siblingFilename,
      channelId,
      keyring,
    );
    const selectedPath = join(harness.sessionsDir, selectedFilename);
    const archivePort = createFilesystemSessionArchivePort();
    const expectedArchiveFingerprint = fingerprintJournalArchiveGeneration(
      archivePort,
      [archivePort.openArchive(channelId, selectedPath)],
    )!;

    const report = runSessionIntegrityRepair({
      sessionsDir: harness.sessionsDir,
      backupDir: harness.backupDir,
      keyring,
      reason: 'repair one evidence-bound chain',
      targetJournalChain: {
        channelId,
        filePaths: [selectedPath],
        expectedArchiveFingerprint,
      },
    });

    expect(report.journal).toMatchObject({ scannedFiles: 1, modifiedFiles: 1 });
    expect(readFileSync(selectedPath, 'utf8')).not.toContain('{not-json}');
    expect(readFileSync(join(harness.sessionsDir, siblingFilename), 'utf8'))
      .toBe(siblingBytes);
    expect(existsSync(join(harness.backupDir, selectedFilename))).toBe(true);
    expect(existsSync(join(harness.backupDir, siblingFilename))).toBe(false);
  });

  it('leaves a replacement generation byte-identical when exact evidence is stale', () => {
    const harness = createHarness();
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:stale-target-key',
      activeVersion: 'v1',
    })!;
    const channelId = 'api:stale-recovery-owner';
    const filename = '20260817_api-stale-recovery-owner_user_000001.jsonl';
    const filePath = join(harness.sessionsDir, filename);
    mkdirSync(harness.sessionsDir, { recursive: true });
    const generationA = signJournalEntry(buildMessageJournalEntry(1, {
      channelId,
      role: 'user',
      content: 'generation A evidence',
      timestamp: 1_000,
    }), keyring, null);
    writeFileSync(filePath, `${JSON.stringify(generationA)}\n`, 'utf8');
    const archivePort = createFilesystemSessionArchivePort();
    const expectedArchiveFingerprint = fingerprintJournalArchiveGeneration(
      archivePort,
      [archivePort.openArchive(channelId, filePath)],
    )!;

    const generationB = signJournalEntry(buildMessageJournalEntry(1, {
      channelId,
      role: 'user',
      content: 'repairable replacement generation B',
      timestamp: 2_000,
    }), keyring, null);
    const replacementBytes = `${JSON.stringify(generationB)}\n{not-json}\n`;
    writeFileSync(filePath, replacementBytes, 'utf8');

    let failure: unknown;
    try {
      runSessionIntegrityRepair({
        sessionsDir: harness.sessionsDir,
        backupDir: harness.backupDir,
        keyring,
        reason: 'reject stale automatic recovery evidence',
        targetJournalChain: {
          channelId,
          filePaths: [filePath],
          expectedArchiveFingerprint,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'ESTALE' });
    expect(readFileSync(filePath, 'utf8')).toBe(replacementBytes);
    expect(existsSync(join(harness.backupDir, filename))).toBe(false);
  });
});
