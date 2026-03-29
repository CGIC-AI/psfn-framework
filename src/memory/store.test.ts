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

    it('serializes insert embeddings using the typed-array byte range', () => {
      const target = makeEmbedding(7);
      const backing = new Float32Array(EMBEDDING_DIMS * 2);
      backing.set(target, EMBEDDING_DIMS);
      const offsetView = backing.subarray(EMBEDDING_DIMS);

      store.insertMemory(
        makeMemory('m-offset-insert', 'Offset insert memory'),
        offsetView,
      );

      const results = store.searchByEmbedding(target, 0.5, 10);
      expect(results.map(result => result.id)).toContain('m-offset-insert');
    });

    it('serializes query embeddings using the typed-array byte range', () => {
      const target = makeEmbedding(8);
      store.insertMemory(
        makeMemory('m-offset-query', 'Offset query memory'),
        target,
      );

      const backing = new Float32Array(EMBEDDING_DIMS * 2);
      backing.set(target, EMBEDDING_DIMS);
      const offsetQuery = backing.subarray(EMBEDDING_DIMS);

      const results = store.searchByEmbedding(offsetQuery, 0.5, 10);
      expect(results.map(result => result.id)).toContain('m-offset-query');
    });

    it('filters by similarity threshold', () => {
      const emb1 = makeEmbedding(1);
      const emb2 = makeEmbedding(100); // Very different

      store.insertMemory(makeMemory('m1', 'Fact A'), emb1);

      const results = store.searchByEmbedding(emb2, 0.95, 10);
      expect(results).toHaveLength(0);
    });

    it('searchByText returns lexical matches for keyword queries', () => {
      store.insertMemory(
        makeMemory('m-love-1', 'PrimaryUser said love is a durable bond.'),
        makeEmbedding(1),
      );
      store.insertMemory(
        makeMemory('m-love-2', 'We discussed kindness and care.', { tags: ['love'] }),
        makeEmbedding(2),
      );
      store.insertMemory(
        makeMemory('m-other', 'No relevant keyword here.'),
        makeEmbedding(3),
      );

      const results = store.searchByText('love', 10);

      expect(results.map(result => result.id)).toContain('m-love-1');
      expect(results.map(result => result.id)).toContain('m-love-2');
      expect(results.map(result => result.id)).not.toContain('m-other');
      expect(results.every(result => result.similarity >= 0.3)).toBe(true);
    });

    it('searchByText excludes superseded and deleted memories', () => {
      store.insertMemory(makeMemory('m-active', 'Active love memory'), makeEmbedding(1));
      store.insertMemory(makeMemory('m-superseded', 'Superseded love memory'), makeEmbedding(2));
      store.insertMemory(makeMemory('m-deleted', 'Deleted love memory'), makeEmbedding(3));

      store.updateMemory('m-superseded', { supersededBy: 'm-replacement' });
      store.softDeleteMemory('m-deleted', { deletedBy: 'test' });

      const results = store.searchByText('love', 10);
      const ids = results.map(result => result.id);

      expect(ids).toContain('m-active');
      expect(ids).not.toContain('m-superseded');
      expect(ids).not.toContain('m-deleted');
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

    it('soft-deletes memory with a checkpoint snapshot and excludes it from active queries', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Delete me'), emb);

      const deleted = store.softDeleteMemory('m1', {
        deletedBy: 'test',
        reason: 'cleanup',
        deleteId: 'del-1',
      });
      expect(deleted).toBeDefined();
      expect(deleted?.deleteId).toBe('del-1');
      expect(deleted?.snapshot.id).toBe('m1');

      const active = store.getAllActiveMemories();
      expect(active).toHaveLength(0);
      const search = store.searchByEmbedding(emb, 0.5, 10);
      expect(search).toHaveLength(0);

      const version = store.getDeleteVersion('del-1');
      expect(version?.memoryId).toBe('m1');
      expect(version?.deleteReason).toBe('cleanup');
      expect(version?.snapshot.text).toBe('Delete me');
    });

    it('undoes soft-delete via delete checkpoint id', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m1', 'Restore me'), emb);
      const deleted = store.softDeleteMemory('m1', {
        deletedBy: 'test',
        deleteId: 'del-restore',
      });
      expect(deleted?.deleteId).toBe('del-restore');

      const restored = store.undoSoftDelete('del-restore', {
        restoredBy: 'test:undo',
      });
      expect(restored).toBeDefined();
      expect(restored?.restoredBy).toBe('test:undo');

      const active = store.getAllActiveMemories();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('m1');
      expect(store.undoSoftDelete('del-restore')).toBeNull();
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

    it('stores and retrieves structured scope refs and scope tags', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m-scope', 'Scoped project fact', {
          scopeRef: { kind: 'project', id: 'proj-alpha', label: 'Alpha' },
          scopeTags: ['project:proj-alpha', 'scope:alpha'],
        }),
        emb,
      );

      const mem = store.getById('m-scope');
      expect(mem).toBeDefined();
      expect(mem!.scopeRef).toEqual({ kind: 'project', id: 'proj-alpha', label: 'Alpha' });
      expect(mem!.scopeTags).toEqual(['project:proj-alpha', 'scope:alpha']);
    });

    it('filters embedding search by scope query when mode is only', () => {
      const emb = makeEmbedding(2);
      store.insertMemory(
        makeMemory('m-scope-a', 'Project alpha memory', {
          scopeRef: { kind: 'project', id: 'alpha' },
          scopeTags: ['project:alpha'],
        }),
        emb,
      );
      store.insertMemory(
        makeMemory('m-scope-b', 'Project beta memory', {
          scopeRef: { kind: 'project', id: 'beta' },
          scopeTags: ['project:beta'],
        }),
        emb,
      );

      const results = store.searchByEmbedding(emb, 0.5, 10, {
        refs: [{ kind: 'project', id: 'alpha' }],
        mode: 'only',
      });

      expect(results.map(result => result.id)).toEqual(['m-scope-a']);
    });

    it('filters lexical search by scope tags when mode is only', () => {
      store.insertMemory(
        makeMemory('m-text-alpha', 'Memory about deployment plan', {
          scopeTags: ['project:alpha'],
        }),
        makeEmbedding(3),
      );
      store.insertMemory(
        makeMemory('m-text-beta', 'Memory about deployment plan', {
          scopeTags: ['project:beta'],
        }),
        makeEmbedding(4),
      );

      const results = store.searchByText('deployment', 10, {
        tags: ['project:beta'],
        mode: 'only',
      });

      expect(results.map(result => result.id)).toEqual(['m-text-beta']);
    });

    it('stores and retrieves consentFlags', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Consent test', {
          consentFlags: {
            allowRecall: false,
            allowAbstraction: true,
            deleteOnRequest: true,
            redactionBehavior: 'abstract',
          },
        }),
        emb,
      );

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.consentFlags).toEqual({
        allowRecall: false,
        allowAbstraction: true,
        deleteOnRequest: true,
        redactionBehavior: 'abstract',
      });
    });

    it('stores and retrieves formationVAD', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Emotion-context memory', {
          formationVAD: {
            valence: -0.4,
            arousal: 0.9,
            dominance: -0.1,
          },
        }),
        emb,
      );

      const mem = store.getById('m1');
      expect(mem).toBeDefined();
      expect(mem!.formationVAD).toEqual({
        valence: -0.4,
        arousal: 0.9,
        dominance: -0.1,
      });
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

    it('supports LIMIT/OFFSET pagination for active memory listing', () => {
      const base = Date.now();
      store.insertMemory(
        makeMemory('m-old', 'Oldest', {
          extractedAt: base - 3_000,
          lastAccessed: base - 3_000,
        }),
        makeEmbedding(1),
      );
      store.insertMemory(
        makeMemory('m-mid', 'Middle', {
          extractedAt: base - 2_000,
          lastAccessed: base - 2_000,
        }),
        makeEmbedding(2),
      );
      store.insertMemory(
        makeMemory('m-new', 'Newest', {
          extractedAt: base - 1_000,
          lastAccessed: base - 1_000,
        }),
        makeEmbedding(3),
      );

      const page = store.listActiveMemories({ limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
      expect(page[0].id).toBe('m-mid');
      expect(store.countActiveMemories()).toBe(3);
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

    it('stores and retrieves provenance refs', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m-provenance', 'Imported provenance memory', {
          sourceRef: 'legacy:source#0',
          provenanceRefs: ['legacy:source#0', 'backup:archive#3'],
        }),
        emb,
      );

      const mem = store.getById('m-provenance');
      expect(mem?.provenanceRefs).toEqual(['legacy:source#0', 'backup:archive#3']);
    });

    it('stores and retrieves structured source type and provenance', () => {
      const emb = makeEmbedding(4);
      store.insertMemory(
        makeMemory('m-structured', 'Structured provenance memory', {
          sourceRef: 'source:tool:memory_write|invocation:call-9',
          sourceType: 'tool_write',
          provenance: {
            toolName: 'memory_write',
            toolCallId: 'call-9',
          },
        }),
        emb,
      );

      const mem = store.getById('m-structured');
      expect(mem?.sourceType).toBe('tool_write');
      expect(mem?.provenance).toEqual({
        toolName: 'memory_write',
        toolCallId: 'call-9',
      });
    });

    it('records and retrieves memory patch events', () => {
      const emb = makeEmbedding(5);
      store.insertMemory(makeMemory('m-patch', 'Patch target'), emb);

      store.recordPatchEvent({
        id: 'patch-1',
        memoryId: 'm-patch',
        sourceRef: 'source:tool:memory_patch|invocation:call-77',
        sourceType: 'tool_write',
        provenance: {
          toolName: 'memory_patch',
          toolCallId: 'call-77',
        },
        reason: 'belief correction',
        patch: { confidence: 0.9 },
        previousValues: { confidence: 0.4 },
        nextValues: { confidence: 0.9 },
        createdAt: Date.now(),
      });

      const events = store.getPatchEvents('m-patch');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'patch-1',
        memoryId: 'm-patch',
        sourceType: 'tool_write',
        reason: 'belief correction',
        patch: { confidence: 0.9 },
        previousValues: { confidence: 0.4 },
        nextValues: { confidence: 0.9 },
      });
    });

    it('records abstraction links with non-reversible external refs', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(makeMemory('m-source', 'Sensitive source memory'), emb);
      store.insertMemory(makeMemory('m-abstract', 'Generalized lesson memory', {
        type: 'reflection',
      }), emb);

      const link = store.recordAbstractionLink({
        sourceMemoryId: 'm-source',
        abstractedMemoryId: 'm-abstract',
        externalRef: 'abstraction:ext-1',
        createdBy: 'tool:test',
        reason: 'consent request',
      });

      expect(link.sourceMemoryId).toBe('m-source');
      expect(link.abstractedMemoryId).toBe('m-abstract');
      expect(link.externalRef).toBe('abstraction:ext-1');

      const bySource = store.getAbstractionLinksForSourceMemory('m-source');
      expect(bySource).toHaveLength(1);
      expect(bySource[0].externalRef).toBe('abstraction:ext-1');
      expect(bySource[0].externalRef).not.toBe('m-source');

      const byAbstracted = store.getAbstractionLinksForAbstractedMemory('m-abstract');
      expect(byAbstracted).toHaveLength(1);
      expect(byAbstracted[0].sourceMemoryId).toBe('m-source');
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
        summary: 'PrimaryUser is the primary partner and values direct communication.',
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

    it('updateMemory can update consentFlags', () => {
      const emb = makeEmbedding(1);
      store.insertMemory(
        makeMemory('m1', 'Changeable consent', { consentFlags: {} }),
        emb,
      );

      store.updateMemory('m1', { consentFlags: { allowRecall: false, deleteOnRequest: true } });

      const mem = store.getById('m1');
      expect(mem!.consentFlags).toEqual({ allowRecall: false, deleteOnRequest: true });
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
      expect(columns.some(column => column.name === 'provenance_refs')).toBe(true);
      expect(columns.some(column => column.name === 'formation_vad')).toBe(true);
      expect(columns.some(column => column.name === 'source_type')).toBe(true);
      expect(columns.some(column => column.name === 'provenance_json')).toBe(true);
      expect(columns.some(column => column.name === 'scope_ref_kind')).toBe(true);
      expect(columns.some(column => column.name === 'scope_ref_id')).toBe(true);
      expect(columns.some(column => column.name === 'scope_tags')).toBe(true);

      const emb = makeEmbedding(1);
      migratedStore.insertMemory(
        makeMemory('legacy-migrated', 'Legacy schema now supports contact', {
          contactId: 'contact-legacy-1',
          scopeRef: { kind: 'project', id: 'legacy-project' },
          scopeTags: ['project:legacy-project'],
          formationVAD: {
            valence: 0.2,
            arousal: -0.1,
            dominance: 0.4,
          },
        }),
        emb,
      );
      const inserted = migratedStore.getById('legacy-migrated');
      expect(inserted?.contactId).toBe('contact-legacy-1');
      expect(inserted?.scopeRef).toEqual({ kind: 'project', id: 'legacy-project' });
      expect(inserted?.scopeTags).toEqual(['project:legacy-project']);
      expect(inserted?.formationVAD).toEqual({
        valence: 0.2,
        arousal: -0.1,
        dominance: 0.4,
      });

      legacyDb.close();
    });
  });

  describe('Memory Links', () => {
    it('links two memories and retrieves the link', () => {
      store.insertMemory(makeMemory('m1', 'Fact A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'Fact B'), makeEmbedding(2));

      const link = store.linkMemories('m1', 'm2', 'related');
      expect(link).toBeDefined();
      expect(link!.linkType).toBe('related');

      const links = store.getLinkedMemories('m1');
      expect(links).toHaveLength(1);
      expect(links[0].linkType).toBe('related');

      // Should also be found from the other side
      const links2 = store.getLinkedMemories('m2');
      expect(links2).toHaveLength(1);
    });

    it('uses canonical ordering (smaller id first)', () => {
      store.insertMemory(makeMemory('aaa', 'Fact A'), makeEmbedding(1));
      store.insertMemory(makeMemory('zzz', 'Fact Z'), makeEmbedding(2));

      const link = store.linkMemories('zzz', 'aaa');
      expect(link).toBeDefined();
      expect(link!.id1).toBe('aaa');
      expect(link!.id2).toBe('zzz');
    });

    it('returns null for duplicate links', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      const first = store.linkMemories('m1', 'm2');
      expect(first).toBeDefined();

      const duplicate = store.linkMemories('m1', 'm2');
      expect(duplicate).toBeNull();
    });

    it('returns null when linking a memory to itself', () => {
      store.insertMemory(makeMemory('m1', 'Fact'), makeEmbedding(1));
      const link = store.linkMemories('m1', 'm1');
      expect(link).toBeNull();
    });

    it('returns null for empty ids', () => {
      expect(store.linkMemories('', 'm2')).toBeNull();
      expect(store.linkMemories('m1', '')).toBeNull();
    });

    it('unlinks memories', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      store.linkMemories('m1', 'm2');
      expect(store.getLinkedMemories('m1')).toHaveLength(1);

      const removed = store.unlinkMemories('m1', 'm2');
      expect(removed).toBe(true);
      expect(store.getLinkedMemories('m1')).toHaveLength(0);
    });

    it('unlink returns false for non-existent link', () => {
      expect(store.unlinkMemories('m1', 'm2')).toBe(false);
    });

    it('unlink works regardless of id order', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      store.linkMemories('m1', 'm2');
      // Unlink with reversed order
      const removed = store.unlinkMemories('m2', 'm1');
      expect(removed).toBe(true);
    });

    it('returns empty array for memory with no links', () => {
      store.insertMemory(makeMemory('m1', 'Alone'), makeEmbedding(1));
      expect(store.getLinkedMemories('m1')).toHaveLength(0);
    });

    it('defaults link type to related', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      const link = store.linkMemories('m1', 'm2');
      expect(link!.linkType).toBe('related');
    });

    it('supports custom link types', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      const link = store.linkMemories('m1', 'm2', 'supersedes');
      expect(link!.linkType).toBe('supersedes');
    });
  });

  describe('Bulk Operations', () => {
    it('bulkDelete soft-deletes multiple memories with snapshots', () => {
      store.insertMemory(makeMemory('m1', 'First'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'Second'), makeEmbedding(2));
      store.insertMemory(makeMemory('m3', 'Third'), makeEmbedding(3));

      const count = store.bulkDelete(['m1', 'm3']);
      expect(count).toBe(2);

      const active = store.getAllActiveMemories();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('m2');

      // Verify m1 has a delete version (snapshot preserved)
      const m1 = store.getById('m1');
      expect(m1?.deletedAt).toBeDefined();
      expect(m1?.deletedBy).toBe('admin:bulk');
    });

    it('bulkDelete returns 0 for empty array', () => {
      expect(store.bulkDelete([])).toBe(0);
    });

    it('bulkDelete skips already-deleted memories', () => {
      store.insertMemory(makeMemory('m1', 'First'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'Second'), makeEmbedding(2));

      store.softDeleteMemory('m1', { deletedBy: 'test' });

      const count = store.bulkDelete(['m1', 'm2']);
      expect(count).toBe(1);
    });

    it('bulkDelete skips non-existent ids without error', () => {
      store.insertMemory(makeMemory('m1', 'First'), makeEmbedding(1));
      const count = store.bulkDelete(['m1', 'nonexistent']);
      expect(count).toBe(1);
    });

    it('bulkUpdate changes type for multiple memories', () => {
      store.insertMemory(makeMemory('m1', 'A', { type: 'semantic' }), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B', { type: 'semantic' }), makeEmbedding(2));
      store.insertMemory(makeMemory('m3', 'C', { type: 'emotional' }), makeEmbedding(3));

      const count = store.bulkUpdate(['m1', 'm2'], { type: 'episodic' });
      expect(count).toBe(2);

      expect(store.getById('m1')?.type).toBe('episodic');
      expect(store.getById('m2')?.type).toBe('episodic');
      expect(store.getById('m3')?.type).toBe('emotional'); // untouched
    });

    it('bulkUpdate changes sensitivity for multiple memories', () => {
      store.insertMemory(makeMemory('m1', 'A', { sensitivity: 'personal' }), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B', { sensitivity: 'personal' }), makeEmbedding(2));

      const count = store.bulkUpdate(['m1', 'm2'], { sensitivity: 'confidential' });
      expect(count).toBe(2);

      expect(store.getById('m1')?.sensitivity).toBe('confidential');
      expect(store.getById('m2')?.sensitivity).toBe('confidential');
    });

    it('bulkUpdate returns 0 for empty ids', () => {
      expect(store.bulkUpdate([], { type: 'semantic' })).toBe(0);
    });

    it('bulkUpdate returns 0 for empty fields', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      expect(store.bulkUpdate(['m1'], {})).toBe(0);
    });

    it('bulkUpdate skips soft-deleted memories', () => {
      store.insertMemory(makeMemory('m1', 'A'), makeEmbedding(1));
      store.insertMemory(makeMemory('m2', 'B'), makeEmbedding(2));

      store.softDeleteMemory('m1', { deletedBy: 'test' });

      const count = store.bulkUpdate(['m1', 'm2'], { type: 'episodic' });
      expect(count).toBe(1);
    });

    it('bulkUpdate can update both type and sensitivity at once', () => {
      store.insertMemory(makeMemory('m1', 'A', { type: 'semantic', sensitivity: 'personal' }), makeEmbedding(1));

      const count = store.bulkUpdate(['m1'], { type: 'relational', sensitivity: 'intimate' });
      expect(count).toBe(1);

      const mem = store.getById('m1');
      expect(mem?.type).toBe('relational');
      expect(mem?.sensitivity).toBe('intimate');
    });
  });
});
