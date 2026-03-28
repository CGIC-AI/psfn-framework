import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteCompanionStore } from './sqlite-companion-store.js';

describe('createSqliteCompanionStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('opens the sqlite companion database and assembles the memory store', () => {
    const rootDir = makeTempDir('psfn-sqlite-companion-store-');
    const companionDataDir = join(rootDir, 'companion-data');
    const databasePath = join(companionDataDir, 'companion.db');

    const store = createSqliteCompanionStore({
      databasePath,
      companionDataDir,
      embeddingDims: 8,
    });

    expect(existsSync(databasePath)).toBe(true);
    expect(store.memoryStore.countActiveMemories()).toBe(0);

    store.db.close();
  });
});
