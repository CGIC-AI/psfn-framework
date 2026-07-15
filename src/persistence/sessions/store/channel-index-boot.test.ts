import * as fs from 'node:fs';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
  };
});

import { SessionStore } from '../store.js';

describe('session channel-index boot fingerprints', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.mocked(fs.openSync).mockClear();
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('uses the unchanged fingerprint to avoid a metadata rebuild and rebuilds a changed journal', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-channel-index-boot-'));
    roots.push(root);
    const writer = new SessionStore(root);
    writer.append({
      channelId: 'api:boot-fingerprint',
      role: 'user',
      content: 'first',
      timestamp: 1_000,
    });

    // The first restart upgrades the pre-fingerprint index row.
    new SessionStore(root);
    const journalPath = join(root, readdirSync(root).find(name => name.endsWith('.jsonl'))!);
    const openSpy = vi.mocked(fs.openSync);
    openSpy.mockClear();

    new SessionStore(root);
    expect(openSpy.mock.calls.filter(call => call[0] === journalPath)).toHaveLength(1);

    appendFileSync(journalPath, `${JSON.stringify({
      type: 'message',
      id: 2,
      channelId: 'api:boot-fingerprint',
      role: 'assistant',
      content: 'changed',
      timestamp: 2_000,
    })}\n`, 'utf-8');
    openSpy.mockClear();

    const changed = new SessionStore(root);
    expect(openSpy.mock.calls.some(call => call[0] === journalPath)).toBe(true);
    expect(changed.getRecent('api:boot-fingerprint', 2).map(entry => entry.content)).toEqual([
      'first',
      'changed',
    ]);
  });

  it('repairs an index-only channelId mutation from the canonical journal identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-channel-index-identity-'));
    roots.push(root);
    const privateChannelId = 'api:partner-private';
    const forgedChannelId = 'api:other-partner';
    const writer = new SessionStore(root);
    writer.append({
      channelId: privateChannelId,
      role: 'user',
      content: 'private partner data',
      timestamp: 1_000,
    });

    // Upgrade the index to the fingerprint-bearing format, then corrupt only
    // its derived channelId. The journal itself (and therefore its valid
    // filename/mtime/size fingerprint) remains untouched.
    new SessionStore(root);
    const indexPath = join(root, '_channel_index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      channels: Record<string, { channelId?: string }>;
    };
    const indexedEntry = Object.values(index.channels)[0];
    expect(indexedEntry).toBeDefined();
    indexedEntry!.channelId = forgedChannelId;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');

    const restarted = new SessionStore(root);
    expect(restarted.getRecent(forgedChannelId, 10)).toEqual([]);
    expect(restarted.getRecent(privateChannelId, 10).map(entry => entry.content)).toEqual([
      'private partner data',
    ]);

    const repaired = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      channels: Record<string, { channelId?: string }>;
    };
    expect(Object.values(repaired.channels).map(entry => entry.channelId)).toEqual([privateChannelId]);
  });
});
