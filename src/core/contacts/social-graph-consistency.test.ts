import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import { reconcileSocialGraphConsistency } from './store/social-graph.js';
import type { SocialRelationshipKind } from './types.js';

const PRIMARY_USER_ID = 'discord-primary-123';

describe('social-graph bidirectional consistency + edge hygiene (E4.3)', () => {
  let db: Database.Database;
  let store: ContactStore;
  let entityIds: string[];

  function makeEntities(count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const contact = store.upsert({ displayName: `P${i}`, discordUserId: `p-${i}` });
      ids.push(store.getSocialGraphEntityByContactId(contact.id)!.id);
    }
    return ids;
  }

  function rawInsertEdge(row: {
    id: string;
    source: string;
    target: string;
    type: SocialRelationshipKind;
    directional: 0 | 1;
    confidence?: number;
    provenance?: string[];
    evidence?: string[];
  }): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO social_relationship_edges (
        id, source_entity_id, target_entity_id, relationship_type, directional,
        sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.source, row.target, row.type, row.directional,
      'personal', JSON.stringify(row.provenance ?? []), JSON.stringify(row.evidence ?? []),
      row.confidence ?? 0.7, now, now,
    );
  }

  function allRows(): Array<{ source_entity_id: string; target_entity_id: string; relationship_type: string; directional: number }> {
    return db.prepare('SELECT source_entity_id, target_entity_id, relationship_type, directional FROM social_relationship_edges').all() as never;
  }

  function assertConsistent(): void {
    const report = store.reconcileSocialGraphConsistency({ apply: false });
    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);
    entityIds = makeEntities(5);
  });

  describe('upsert enforcement', () => {
    it('normalizes a symmetric type written directional:true to a single undirected canonical edge', () => {
      const [a, b] = entityIds;
      const edge = store.upsertSocialRelationshipEdge({
        sourceEntityId: b > a ? b : a, // force non-canonical source
        targetEntityId: b > a ? a : b,
        relationshipType: 'friend',
        directional: true,
      });
      expect(edge.directional).toBe(false);
      const [low, high] = [a, b].sort();
      expect(edge.sourceEntityId).toBe(low);
      expect(edge.targetEntityId).toBe(high);
      // Exactly one row.
      expect(allRows()).toHaveLength(1);
      assertConsistent();
    });

    it('maintains a linked child mirror when a parent edge is written', () => {
      const [a, b] = entityIds;
      const parent = store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'parent',
        directional: true,
        confidence: 0.6,
        evidenceMemoryIds: ['mem-1'],
        provenanceRefs: ['prov-1'],
      });
      expect(parent.relationshipType).toBe('parent');
      expect(parent.directional).toBe(true);

      const rows = allRows();
      expect(rows).toHaveLength(2);
      const child = rows.find(r => r.relationship_type === 'child');
      expect(child).toBeDefined();
      expect(child!.source_entity_id).toBe(b);
      expect(child!.target_entity_id).toBe(a);
      expect(child!.directional).toBe(1);
      assertConsistent();
    });

    it('propagates confidence/evidence updates across the mirror pair', () => {
      const [a, b] = entityIds;
      store.upsertSocialRelationshipEdge({
        sourceEntityId: a, targetEntityId: b, relationshipType: 'manager',
        directional: true, confidence: 0.5, evidenceMemoryIds: ['e1'], provenanceRefs: ['p1'],
      });
      // Update via the OTHER side (direct_report B->... no, manager is a->b so mirror is direct_report b->a).
      store.upsertSocialRelationshipEdge({
        sourceEntityId: b, targetEntityId: a, relationshipType: 'direct_report',
        directional: true, confidence: 0.9, evidenceMemoryIds: ['e2'], provenanceRefs: ['p2'],
      });

      const managerEdge = store.listSocialRelationshipEdges({
        entityId: a, relationshipType: 'manager',
        viewerTrustLevel: 'primary', viewerChannelPrivacy: 'private',
      })[0];
      const reportEdge = store.listSocialRelationshipEdges({
        entityId: a, relationshipType: 'direct_report',
        viewerTrustLevel: 'primary', viewerChannelPrivacy: 'private',
      })[0];

      expect(managerEdge.confidence).toBe(0.9);
      expect(reportEdge.confidence).toBe(0.9);
      expect(managerEdge.evidenceMemoryIds.sort()).toEqual(['e1', 'e2']);
      expect(reportEdge.evidenceMemoryIds.sort()).toEqual(['e1', 'e2']);
      expect(managerEdge.provenanceRefs).toEqual(expect.arrayContaining(['p1', 'p2']));
      expect(reportEdge.provenanceRefs).toEqual(expect.arrayContaining(['p1', 'p2']));
      assertConsistent();
    });

    it('stores a genuinely-directional caregiver edge with no mirror', () => {
      const [a, b] = entityIds;
      store.upsertSocialRelationshipEdge({
        sourceEntityId: a, targetEntityId: b, relationshipType: 'caregiver', directional: true,
      });
      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].relationship_type).toBe('caregiver');
      assertConsistent();
    });
  });

  describe('reconcile hygiene on synthetic dirty data', () => {
    it('collapses a symmetric edge marked directional (dry-run reports, apply fixes)', () => {
      const [a, b] = entityIds.slice().sort();
      rawInsertEdge({ id: 'edge:dirty-1', source: a, target: b, type: 'friend', directional: 1, confidence: 0.8, evidence: ['x'] });

      const dry = store.reconcileSocialGraphConsistency({ apply: false });
      expect(dry.findings.some(f => f.kind === 'symmetric_marked_directional')).toBe(true);
      expect(dry.fixedCount).toBe(0);
      // Still dirty after dry-run.
      expect(allRows()).toHaveLength(1);
      expect(allRows()[0].directional).toBe(1);

      const applied = store.reconcileSocialGraphConsistency({ apply: true });
      expect(applied.fixedCount).toBeGreaterThan(0);
      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].directional).toBe(0);
      assertConsistent();
    });

    it('creates a missing inverse mirror under --apply with shared evidence', () => {
      const [a, b] = entityIds;
      rawInsertEdge({ id: 'edge:dirty-parent', source: a, target: b, type: 'parent', directional: 1, confidence: 0.7, evidence: ['ev'] });

      const dry = store.reconcileSocialGraphConsistency({ apply: false });
      expect(dry.findings.some(f => f.kind === 'missing_mirror')).toBe(true);
      expect(allRows()).toHaveLength(1);

      store.reconcileSocialGraphConsistency({ apply: true });
      const rows = allRows();
      expect(rows).toHaveLength(2);
      const child = store.listSocialRelationshipEdges({
        entityId: b, relationshipType: 'child',
        viewerTrustLevel: 'primary', viewerChannelPrivacy: 'private',
      })[0];
      expect(child).toBeDefined();
      expect(child.evidenceMemoryIds).toEqual(['ev']);
      assertConsistent();
    });

    it('collapses duplicate pair rows under --apply (unconstrained/legacy schema)', () => {
      // The canonical sqlite schema has a UNIQUE(source,target,type,directional)
      // constraint, so duplicate rows cannot exist there. This stage is defensive
      // for legacy/Postgres schemas without the constraint — exercise it on a
      // minimal table that permits duplicates.
      const legacy = new Database(':memory:');
      legacy.exec(`
        CREATE TABLE social_relationship_edges (
          id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL,
          target_entity_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL,
          directional INTEGER NOT NULL DEFAULT 1,
          sensitivity TEXT NOT NULL DEFAULT 'personal',
          provenance_refs TEXT NOT NULL DEFAULT '[]',
          evidence_memory_ids TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.7,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      const insert = (id: string, confidence: number, evidence: string[]): void => {
        legacy.prepare(`
          INSERT INTO social_relationship_edges (
            id, source_entity_id, target_entity_id, relationship_type, directional,
            sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
          ) VALUES (?, 'e:a', 'e:b', 'friend', 0, 'personal', '[]', ?, ?, ?, ?)
        `).run(id, JSON.stringify(evidence), confidence, now, now);
      };
      insert('edge:dup-1', 0.4, ['a']);
      insert('edge:dup-2', 0.9, ['b']);

      const dry = reconcileSocialGraphConsistency(legacy, { apply: false });
      expect(dry.findings.some(f => f.kind === 'duplicate_pair')).toBe(true);
      expect(dry.fixedCount).toBe(0);

      const applied = reconcileSocialGraphConsistency(legacy, { apply: true });
      expect(applied.fixedCount).toBeGreaterThan(0);
      const rows = legacy.prepare('SELECT * FROM social_relationship_edges').all() as Array<{ confidence: number; evidence_memory_ids: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.9);
      expect(JSON.parse(rows[0].evidence_memory_ids).sort()).toEqual(['a', 'b']);
      // Second pass is a no-op.
      expect(reconcileSocialGraphConsistency(legacy, { apply: true }).fixedCount).toBe(0);
      legacy.close();
    });

    it('re-orders a non-canonical undirected edge under --apply', () => {
      const [a, b] = entityIds.slice().sort();
      // Insert with reversed (non-canonical) endpoints.
      rawInsertEdge({ id: 'edge:noncanon', source: b, target: a, type: 'acquaintance', directional: 0 });

      const dry = store.reconcileSocialGraphConsistency({ apply: false });
      expect(dry.findings.some(f => f.kind === 'non_canonical_undirected')).toBe(true);

      store.reconcileSocialGraphConsistency({ apply: true });
      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].source_entity_id).toBe(a);
      expect(rows[0].target_entity_id).toBe(b);
      assertConsistent();
    });

    it('reports ambiguous inverse-marked-undirected without mutating', () => {
      const [a, b] = entityIds.slice().sort();
      rawInsertEdge({ id: 'edge:ambig', source: a, target: b, type: 'parent', directional: 0 });

      const applied = store.reconcileSocialGraphConsistency({ apply: true });
      const ambiguous = applied.findings.find(f => f.kind === 'inverse_marked_undirected');
      expect(ambiguous).toBeDefined();
      expect(ambiguous!.ambiguous).toBe(true);
      expect(ambiguous!.fixed).toBe(false);
      // Untouched.
      expect(allRows()).toHaveLength(1);
      expect(allRows()[0].directional).toBe(0);
    });

    it('reports ambiguous conflicting mirror without mutating', () => {
      const [a, b] = entityIds;
      rawInsertEdge({ id: 'edge:pm', source: a, target: b, type: 'parent', directional: 1 });
      // Reversed endpoints carry a DIFFERENT inverse-pair type (manager) — conflict.
      rawInsertEdge({ id: 'edge:conf', source: b, target: a, type: 'manager', directional: 1 });

      const applied = store.reconcileSocialGraphConsistency({ apply: true });
      const conflict = applied.findings.find(f => f.kind === 'conflicting_mirror');
      expect(conflict).toBeDefined();
      expect(conflict!.ambiguous).toBe(true);
      expect(conflict!.fixed).toBe(false);
    });

    it('is idempotent: a second apply finds nothing to fix', () => {
      const [a, b] = entityIds.slice().sort();
      rawInsertEdge({ id: 'edge:i1', source: a, target: b, type: 'friend', directional: 1 });
      rawInsertEdge({ id: 'edge:i2', source: entityIds[0], target: entityIds[2], type: 'parent', directional: 1 });

      store.reconcileSocialGraphConsistency({ apply: true });
      const second = store.reconcileSocialGraphConsistency({ apply: true });
      expect(second.fixedCount).toBe(0);
      assertConsistent();
    });
  });

  describe('property: any sequence of public upserts leaves the graph consistent', () => {
    it('stays consistent under a pseudo-random write sequence', () => {
      const kinds: SocialRelationshipKind[] = [
        'friend', 'partner', 'sibling', 'household', 'colleague', 'acquaintance', 'family',
        'parent', 'child', 'manager', 'direct_report', 'caregiver', 'other',
      ];
      // Deterministic LCG for reproducibility.
      let seed = 1234567;
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };

      for (let step = 0; step < 300; step += 1) {
        let i = Math.floor(rand() * entityIds.length);
        let j = Math.floor(rand() * entityIds.length);
        if (i === j) j = (j + 1) % entityIds.length;
        const kind = kinds[Math.floor(rand() * kinds.length)];
        const directional = rand() > 0.5;
        store.upsertSocialRelationshipEdge({
          sourceEntityId: entityIds[i],
          targetEntityId: entityIds[j],
          relationshipType: kind,
          directional,
          confidence: rand(),
          evidenceMemoryIds: [`m-${step}`],
        });
        // Invariant must hold after EVERY write.
        assertConsistent();
      }
    });
  });
});
