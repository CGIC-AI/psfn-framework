import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeRolledFilePath } from './channel-filenames.js';
import { discoverSessionFileChains } from './session-file-chains.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('discoverSessionFileChains', () => {
  it('inherits the root channel for an empty materialized active segment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-file-chain-'));
    roots.push(dir);
    const rootPath = join(dir, '20260325_api-empty-segment_user_000001.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    writeFileSync(rootPath, `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:empty-segment',
      role: 'assistant',
      content: 'completed turn',
      timestamp: 1,
    })}\n`, 'utf8');
    writeFileSync(segmentPath, '', 'utf8');

    const discovered = discoverSessionFileChains(dir);

    expect(discovered.incompleteChains).toEqual([]);
    expect(discovered.chains).toEqual([{
      channelId: 'api:empty-segment',
      rootFilename: basename(rootPath),
      filenames: [basename(rootPath), basename(segmentPath)],
      filePaths: [rootPath, segmentPath],
    }]);
  });
});
