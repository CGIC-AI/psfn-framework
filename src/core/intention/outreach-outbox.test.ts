import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileOutreachOutboxStore } from './outreach-outbox.js';

describe('createFileOutreachOutboxStore', () => {
  it('appends audit records and rehydrates terminal dedupe guards', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-outreach-outbox-'));
    try {
      const ledgerPath = join(tempDir, 'outreach-outbox.jsonl');
      const store = createFileOutreachOutboxStore(ledgerPath);
      store.append({
        phase: 'queued',
        actionId: 'action-1',
        dedupeKey: 'dedupe-1',
        channelId: 'primary-dm',
        channelType: 'discord',
        sourceMessageId: 'msg-1',
        contentHash: 'hash-1',
        contentLength: 12,
      });
      store.append({
        phase: 'sent',
        actionId: 'action-1',
        dedupeKey: 'dedupe-1',
        channelId: 'primary-dm',
        channelType: 'discord',
        sourceMessageId: 'msg-1',
        contentHash: 'hash-1',
        contentLength: 12,
      });

      const rehydrated = createFileOutreachOutboxStore(ledgerPath);
      expect(rehydrated.hasTerminal('dedupe-1')).toBe(true);
      expect(rehydrated.getTerminal('dedupe-1')).toMatchObject({
        phase: 'sent',
        actionId: 'action-1',
      });
      expect(readFileSync(ledgerPath, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores malformed historical lines without creating replay authorization', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-outreach-outbox-'));
    try {
      const ledgerPath = join(tempDir, 'outreach-outbox.jsonl');
      writeFileSync(
        ledgerPath,
        [
          '{"version":1,"phase":"sent","dedupeKey":"missing-required"}',
          'not json',
          '',
        ].join('\n'),
        'utf-8',
      );

      const store = createFileOutreachOutboxStore(ledgerPath);
      expect(store.hasTerminal('missing-required')).toBe(false);
      expect(store.listRecent()).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
