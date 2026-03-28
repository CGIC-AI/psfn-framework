import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../sessions/store.js';
import {
  buildExtractionMarkerJournalEntry,
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  signJournalEntry,
} from '../journals/journal-utils.js';
import { runSessionIntegrityRepair } from './integrity-repair.js';
import type { JournalEntry } from '../../core/session/types.js';

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
      disableSearchIndex: true,
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
      disableSearchIndex: true,
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
    });
    expect(report.journal.modifiedFiles).toBe(1);
    expect(report.journal.modifiedEntries).toBe(1);

    const store = new SessionStore(harness.sessionsDir, {
      integrityKeyring: keyring,
      disableSearchIndex: true,
    });
    const entries = store.getRecent('api:tampered', 10);
    expect(entries.map(entry => entry.content)).toEqual(['original first', 'tampered second']);
    expect(entries.some(entry => entry.content.includes('<unverified_history>'))).toBe(false);
  });
});
