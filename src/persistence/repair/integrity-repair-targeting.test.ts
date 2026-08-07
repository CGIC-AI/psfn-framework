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
});
