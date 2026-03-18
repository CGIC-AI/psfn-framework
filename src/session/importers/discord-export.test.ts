import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJournalFile } from '../journal-utils.js';
import { importDiscordExportToL0 } from './discord-export.js';

describe('importDiscordExportToL0', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it('converts a DiscordChatExporter JSON export into an L0 session file', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-discord-import-'));
    cleanupPaths.push(root);
    const sourcePath = join(root, 'dm.json');
    const sessionsDir = join(root, 'sessions');
    writeFileSync(sourcePath, JSON.stringify({
      channel: { id: '1313001762793197678', name: 'Purrsephone Prime' },
      messages: [
        {
          id: '1',
          type: 'Default',
          timestamp: '2026-02-14T00:48:06.275-05:00',
          content: 'Hu',
          author: {
            id: '388908766306893854',
            name: 'daisukearamaki',
            nickname: 'Vega',
            isBot: false,
          },
          attachments: [],
        },
        {
          id: '2',
          type: 'Default',
          timestamp: '2026-02-14T00:48:10.770-05:00',
          content: '',
          author: {
            id: '1050938702622375987',
            name: 'Purrsephone Prime',
            nickname: 'Purrsephone Prime',
            isBot: true,
          },
          attachments: [
            {
              id: 'att-1',
              fileName: 'image.png',
            },
          ],
        },
      ],
    }, null, 2));

    const result = importDiscordExportToL0({
      sourcePath,
      sessionsDir,
    });

    expect(result.summary.channelId).toBe('1313001762793197678');
    expect(result.summary.messageCount).toBe(2);

    const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);

    const journal = readJournalFile(join(sessionsDir, files[0]!));
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]?.role).toBe('user');
    expect(journal.entries[0]?.discordMessageId).toBe('1');
    expect(journal.entries[1]?.role).toBe('assistant');
    expect(journal.entries[1]?.content).toContain('Discord attachment-only message');
  });
});
