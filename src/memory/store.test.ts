import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryStore } from './store.js';
import { DEFAULT_EMBEDDING_CONFIG } from './embedding.js';
import type { PurrMemory } from './types.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;

function makeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    arr[i] = Math.sin(seed + i * 0.1);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMS; i++) arr[i] /= norm;
  return arr;
}

function makeMemory(id: string, text: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0.0,
    salience: 0.8,
    sourceRef: 'ch1:1000',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 1,
    tags: ['test'],
    sensitivity: 'personal',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    store = new MemoryStore(db);
  });

  describe('L2 Memories', () => {
    it('inserts and retrieves memories by embedding', () => {
      const emb = makeEmbedding(1);
      const mem = makeMemory('m1', 'User is a programmer');
      store.insertMemory(mem, emb);

      const results = store.searchByEmbedding(emb, 0.5, 10);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('User is a programmer');
      expect(results[0].similarity).toBeGreaterThan(0.99);
    });

    it('filters by similarity threshold', () => {
      const emb1 = makeEmbedding(1);
      const emb2 = makeEmbedding(100); // Very different

      store.insertMemory(makeMemory('m1', 'Fact A'), emb1);

      const results = store.searchByEmbedding(emb2, 0.95, 10);
      expect(results).toHaveLength(0);
    });

    it('updates memory fields', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Test', { salience: 0.8 }), emb);

      store.updateMemory('m1', { salience: 0.3, accessCount: 5 });

      const all = store.getAllActiveMemories();
      expect(all[0].salience).toBe(0.3);
      expect(all[0].accessCount).toBe(5);
    });

    it('superseded memories are excluded from active list', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Old fact'), emb);
      store.updateMemory('m1', { supersededBy: 'm2' });

      const active = store.getAllActiveMemories();
      expect(active).toHaveLength(0);
    });

    it('superseded memories are excluded from search', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Old fact'), emb);
      store.updateMemory('m1', { supersededBy: 'm2' });

      const results = store.searchByEmbedding(emb, 0.5, 10);
      expect(results).toHaveLength(0);
    });

    it('stores and retrieves sensitivity field', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Intimate fact', { sensitivity: 'intimate' }),
        emb,
      );

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.sensitivity).toBe('intimate');
    });

    it('stores and retrieves consentFlags', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Consent test', {
          consentFlags: { allowRecall: false, deleteOnRequest: true },
        }),
        emb,
      );

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.consentFlags).toEqual({ allowRecall: false, deleteOnRequest: true });
    });

    it('defaults sensitivity to personal for records without it', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Default sensitivity'), emb);

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.sensitivity).toBe('personal');
    });

    it('defaults consentFlags to empty object for records without it', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Default consent'), emb);

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.consentFlags).toEqual({});
    });

    it('searchByEmbedding returns sensitivity in results', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Confidential fact', { sensitivity: 'confidential' }),
        emb,
      );

      const results = store.searchByEmbedding(emb, 0.5, 10);
      expect(results).toHaveLength(1);
      expect(results[0].sensitivity).toBe('confidential');
    });

    it('getAllActiveMemories returns sensitivity', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Public fact', { sensitivity: 'public' }),
        emb,
      );

      const active = store.getAllActiveMemories();
      expect(active).toHaveLength(1);
      expect(active[0].sensitivity).toBe('public');
    });

    it('getMemoriesByChannel returns sensitivity', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Channel fact', {
          sourceRef: 'chan1:1000',
          sensitivity: 'intimate',
        }),
        emb,
      );

      const results = store.getMemoriesByChannel('chan1', 10);
      expect(results).toHaveLength(1);
      expect(results[0].sensitivity).toBe('intimate');
    });

    it('stores and retrieves contactId', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Canonical contact memory', {
          contactId: 'contact-canonical-1',
        }),
        emb,
      );

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem?.contactId).toBe('contact-canonical-1');
    });

    it('getMemoriesByContact returns active memories for canonical contact', () => {
      const embA = makeEmbedding(1);
      const embB = makeEmbedding(2);
      const embC = makeEmbedding(3);

      store.insertMemory(
        makeMemory('m1', 'Contact A memory', { contactId: 'contact-a', salience: 0.8 }),
        embA,
      );
      store.insertMemory(
        makeMemory('m2', 'Contact B memory', { contactId: 'contact-b', salience: 0.9 }),
        embB,
      );
      store.insertMemory(
        makeMemory('m3', 'Contact A older memory', { contactId: 'contact-a', salience: 0.4 }),
        embC,
      );
      store.updateMemory('m3', { supersededBy: 'm4' });

      const contactA = store.getMemoriesByContact('contact-a', 10);
      expect(contactA).toHaveLength(1);
      expect(contactA[0].id).toBe('m1');
    });

    it('persists and retrieves contact profile artifacts', () => {
      store.upsertContactProfile({
        contactId: 'contact-canonical-1',
        summary: 'Operator is the primary partner and values direct communication.',
        sourceMemoryIds: ['m1', 'm2'],
        confidenceScore: 0.92,
        noveltyScore: 0.44,
        updatedAt: Date.now(),
      });

      const profile = store.getContactProfile('contact-canonical-1');
      expect(profile).toBeDefined();
      expect(profile?.summary).toContain('primary partner');
      expect(profile?.sourceMemoryIds).toEqual(['m1', 'm2']);
      expect(profile?.confidenceScore).toBeCloseTo(0.92, 5);
    });

    it('upsertContactProfile updates existing profile row', () => {
      store.upsertContactProfile({
        contactId: 'contact-canonical-1',
        summary: 'Initial profile summary.',
        sourceMemoryIds: ['m1'],
        confidenceScore: 0.8,
        noveltyScore: 1,
        updatedAt: 1,
      });
      store.upsertContactProfile({
        contactId: 'contact-canonical-1',
        summary: 'Updated profile summary.',
        sourceMemoryIds: ['m2', 'm3'],
        confidenceScore: 0.91,
        noveltyScore: 0.31,
        updatedAt: 2,
      });

      const profile = store.getContactProfile('contact-canonical-1');
      expect(profile?.summary).toBe('Updated profile summary.');
      expect(profile?.sourceMemoryIds).toEqual(['m2', 'm3']);
      expect(profile?.updatedAt).toBe(2);
    });

    it('updateMemory can update sensitivity', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Changeable sensitivity', { sensitivity: 'personal' }),
        emb,
      );

      store.updateMemory('m1', { sensitivity: 'confidential' });

      const mem = store.getById('m1');
      expect(mem!.sensitivity).toBe('confidential');
    });

    it('migration is idempotent (runs twice without error)', () => {
      // The constructor already ran migrateSchema once. Running it again
      // via a second MemoryStore on the same db should not throw.
      const store2 = new MemoryStore(db);
      const emb = makeEmbedding(1);
      store2.insertMemory(
        makeMemory('m2', 'After double migration', { sensitivity: 'public' }),
        emb,
      );
      const mem = store2.getById('m2');
      expect(mem!.sensitivity).toBe('public');
    });

    it('migrates legacy l2_memories schema before creating contact index', () => {
      const legacyDb = new Database(':memory:');
      sqliteVec.load(legacyDb);
      legacyDb.exec(`
        CREATE TABLE l2_memories (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          type TEXT NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          confidence REAL NOT NULL DEFAULT 0.7,
          emotional_valence REAL NOT NULL DEFAULT 0.0,
          salience REAL NOT NULL DEFAULT 0.5,
          source_ref TEXT NOT NULL,
          extracted_at INTEGER NOT NULL,
          last_accessed INTEGER NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 1,
          superseded_by TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          sensitivity TEXT NOT NULL DEFAULT 'personal',
          consent_flags TEXT NOT NULL DEFAULT '{}'
        );
      `);

      const migratedStore = new MemoryStore(legacyDb);
      const columns = legacyDb.prepare('PRAGMA table_info(l2_memories)')
        .all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === 'contact_id')).toBe(true);

      const emb = makeEmbedding(1);
      migratedStore.insertMemory(
        makeMemory('legacy-migrated', 'Legacy schema now supports contact', {
          contactId: 'contact-legacy-1',
        }),
        emb,
      );
      const inserted = migratedStore.getById('legacy-migrated');
      expect(inserted?.contactId).toBe('contact-legacy-1');

      legacyDb.close();
    });
  });
});
