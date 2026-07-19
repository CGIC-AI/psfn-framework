import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store/channel-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store/channel-index.js')>();
  return {
    ...actual,
    migrateLegacyFilenames: vi.fn(actual.migrateLegacyFilenames),
  };
});

import { SessionStore } from './store.js';
import { migrateLegacyFilenames } from './store/channel-index.js';

describe('SessionStore legacy filename boundary', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    vi.mocked(migrateLegacyFilenames).mockClear();
    for (const scratchDir of scratchDirs) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
    scratchDirs.length = 0;
  });

  it('does not invoke the legacy filename migration during normal construction', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-session-current-filenames-'));
    scratchDirs.push(sessionsDir);

    new SessionStore(sessionsDir);

    expect(migrateLegacyFilenames).not.toHaveBeenCalled();
  });

  it('fails closed on the first affected lookup without renaming the legacy file', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-session-legacy-filenames-'));
    scratchDirs.push(sessionsDir);
    const legacyPath = join(sessionsDir, 'retired-session-name.jsonl');
    writeFileSync(legacyPath, `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:session-1',
      role: 'user',
      content: 'legacy session',
      timestamp: 1_700_000_000_000,
    })}\n`, 'utf8');

    const store = new SessionStore(sessionsDir);

    expect(existsSync(legacyPath)).toBe(true);
    expect(() => store.getRecent('api:session-1', 10)).toThrow(
      /npm run migrate:session-filenames -- --sessions-dir .* --apply/u,
    );
    expect(existsSync(legacyPath)).toBe(true);
  });
});
