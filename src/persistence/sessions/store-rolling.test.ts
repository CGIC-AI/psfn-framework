import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JournalEntry } from '../../core/session/types.js';
import {
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  verifyJournalEntryIntegrity,
} from '../journals/journal-utils.js';
import { makeRolledFilePath } from './store/channel-filenames.js';
import {
  L0_SESSION_FILE_MAX_BYTES,
  SessionStore,
} from './store.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';

describe('SessionStore file rolling', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('rolls at 16 MiB only between turns and preserves one projected HMAC-chained session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-rolling-'));
    dirs.push(dir);
    const channelId = 'api:rolling';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:rolling-integrity-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const writer = new SessionStore(dir, { integrityKeyring: keyring });
    writer.append({
      channelId,
      role: 'user',
      content: 'x'.repeat(L0_SESSION_FILE_MAX_BYTES),
      timestamp: 1_000,
    });
    writer.append({
      channelId,
      role: 'assistant',
      content: 'first turn tool request',
      timestamp: 2_000,
    });
    writer.append({
      channelId,
      role: 'tool',
      content: 'first turn tool result',
      timestamp: 3_000,
    });
    writer.append({
      channelId,
      role: 'assistant',
      content: 'first turn reply',
      timestamp: 4_000,
    });

    let index = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf8')) as {
      version: number;
      channels: Record<string, { filename: string; filenames: string[] }>;
    };
    expect(index.channels[channelId].filenames).toHaveLength(1);
    const staleWriter = new SessionStore(dir, { integrityKeyring: keyring });

    writer.append({
      channelId,
      role: 'user',
      content: 'second turn prompt',
      timestamp: 5_000,
    });
    staleWriter.append({
      channelId,
      role: 'assistant',
      content: 'second turn reply',
      timestamp: 6_000,
    });

    index = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf8')) as {
      version: number;
      channels: Record<string, { filename: string; filenames: string[] }>;
    };
    const filenames = index.channels[channelId].filenames;
    expect(filenames).toHaveLength(2);
    expect(index.channels[channelId].filename).toBe(filenames[1]);

    const firstFileEntries = readFileSync(join(dir, filenames[0]!), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    const secondFileEntries = readFileSync(join(dir, filenames[1]!), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(firstFileEntries.map(entry => entry.id)).toEqual([1, 2, 3, 4]);
    expect(secondFileEntries.map(entry => entry.id)).toEqual([5, 6]);
    expect(verifyJournalEntryIntegrity(
      secondFileEntries[0]!,
      keyring!,
      firstFileEntries.at(-1)?._hmac ?? null,
    ).verified).toBe(true);
    expect(verifyJournalEntryIntegrity(secondFileEntries[0]!, keyring!, null).verified).toBe(false);

    const projection: TranscriptProjectionPort = {
      upsertSessionEntry: vi.fn(),
      replaceChannelEntries: vi.fn(),
      countProjectedMessages: vi.fn(() => 0),
      markProjectionDrift: vi.fn(),
      clearProjectionDrift: vi.fn(),
      listProjectionDrift: vi.fn(() => []),
    };
    const reloaded = new SessionStore(dir, {
      integrityKeyring: keyring,
      transcriptProjection: projection,
    });

    expect(reloaded.listChannels()).toEqual([{
      sessionId: channelId,
      channelId,
      messageCount: 6,
    }]);
    expect(reloaded.getRecent(channelId, 3).map(entry => entry.content)).toEqual([
      'first turn reply',
      'second turn prompt',
      'second turn reply',
    ]);
    expect(reloaded.getEntriesInRange(channelId, 4, 5).map(entry => entry.content)).toEqual([
      'first turn reply',
      'second turn prompt',
    ]);
    expect(projection.replaceChannelEntries).toHaveBeenCalledWith(
      channelId,
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
        expect.objectContaining({ id: 3 }),
        expect.objectContaining({ id: 4 }),
        expect.objectContaining({ id: 5 }),
        expect.objectContaining({ id: 6 }),
      ]),
    );
    expect(projection.markProjectionDrift).not.toHaveBeenCalled();

    rmSync(join(dir, '_channel_index.json'));
    const recovered = new SessionStore(dir, { integrityKeyring: keyring });
    expect(recovered.getRecent(channelId, 2).map(entry => entry.content)).toEqual([
      'second turn prompt',
      'second turn reply',
    ]);
    const recoveredIndex = JSON.parse(
      readFileSync(join(dir, '_channel_index.json'), 'utf8'),
    ) as { channels: Record<string, { filenames: string[] }> };
    expect(recoveredIndex.channels[channelId].filenames).toEqual(filenames);
  }, 60_000);

  it('reloads a changed earlier segment before a stale integrity-disabled writer appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-stale-chain-'));
    dirs.push(dir);
    const channelId = 'api:stale-chain';
    const rootPath = join(dir, '20260325_api-stale-chain_user_000001.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    const rootEntries = [
      buildMessageJournalEntry(1, {
        channelId,
        role: 'user',
        content: 'original root prompt',
        timestamp: 1_000,
      }),
      buildMessageJournalEntry(2, {
        channelId,
        role: 'assistant',
        content: 'root reply',
        timestamp: 2_000,
      }),
    ];
    const segmentEntries = [
      buildMessageJournalEntry(3, {
        channelId,
        role: 'user',
        content: 'segment prompt',
        timestamp: 3_000,
      }),
      buildMessageJournalEntry(4, {
        channelId,
        role: 'assistant',
        content: 'segment reply',
        timestamp: 4_000,
      }),
    ];
    const writeEntries = (filePath: string, entries: readonly JournalEntry[]) => {
      writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };
    writeEntries(rootPath, rootEntries);
    writeEntries(segmentPath, segmentEntries);

    const staleWriter = new SessionStore(dir);
    expect(staleWriter.getEntriesInRange(channelId, 1, 4)).toHaveLength(4);
    writeEntries(rootPath, [{ ...rootEntries[0]!, content: 'rewritten root prompt' }, rootEntries[1]!]);

    staleWriter.append({
      channelId,
      role: 'user',
      content: 'appended after external rewrite',
      timestamp: 5_000,
    });

    expect(staleWriter.getEntriesInRange(channelId, 1, 5).map(entry => entry.content)).toEqual([
      'rewritten root prompt',
      'root reply',
      'segment prompt',
      'segment reply',
      'appended after external rewrite',
    ]);
  });
});
