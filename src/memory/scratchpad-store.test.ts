import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sqliteVec from 'sqlite-vec';
import { MemoryStore } from './store.js';

describe('MemoryStore scratchpad persistence', () => {
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    store = new MemoryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('supports add, list, replace, and remove operations', () => {
    const added = store.addScratchpadEntry('  first working note  ', {
      id: 'sp-1',
      now: 1_700_000_000_000,
    });
    expect(added.entry.id).toBe('sp-1');
    expect(added.entry.content).toBe('first working note');
    expect(added.evictedIds).toEqual([]);

    const listed = store.listScratchpadEntries();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('sp-1');

    const replaced = store.replaceScratchpadEntry('sp-1', 'updated note', {
      now: 1_700_000_100_000,
    });
    expect(replaced?.content).toBe('updated note');
    expect(replaced?.updatedAt).toBe(1_700_000_100_000);

    expect(store.removeScratchpadEntry('sp-1')).toBe(true);
    expect(store.removeScratchpadEntry('sp-1')).toBe(false);
    expect(store.listScratchpadEntries()).toEqual([]);
  });

  it('enforces bounded capacity by evicting oldest entries', () => {
    for (let i = 0; i < 65; i++) {
      store.addScratchpadEntry(`note-${i}`, { id: `sp-${i}`, now: i + 1 });
    }

    const listed = store.listScratchpadEntries(64);
    expect(listed).toHaveLength(64);
    const ids = new Set(listed.map(entry => entry.id));
    expect(ids.has('sp-0')).toBe(false);
    expect(ids.has('sp-1')).toBe(true);
    expect(ids.has('sp-64')).toBe(true);
  });

  it('persists scratchpad entries across reopened stores', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-scratchpad-'));
    const dbPath = join(tempDir, 'scratchpad.db');

    const firstDb = new Database(dbPath);
    sqliteVec.load(firstDb);
    const firstStore = new MemoryStore(firstDb);
    firstStore.addScratchpadEntry('persist this note', {
      id: 'sp-persist',
      now: 1_700_000_000_000,
    });
    firstDb.close();

    const secondDb = new Database(dbPath);
    sqliteVec.load(secondDb);
    const secondStore = new MemoryStore(secondDb);
    const listed = secondStore.listScratchpadEntries();

    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('sp-persist');
    expect(listed[0].content).toBe('persist this note');

    secondDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
