import * as fs from 'node:fs';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

  it('skips first-line reads for unchanged journals and rereads a changed journal', () => {
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
    expect(openSpy.mock.calls.filter(call => call[0] === journalPath)).toHaveLength(0);

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
});
