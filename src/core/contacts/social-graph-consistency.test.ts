import { beforeEach, describe, expect, it } from 'vitest';
import type { ContactStorePort } from './contact-store-port.js';
import {
  classifySocialRelationship,
  inverseRelationshipKind,
} from './social-relationship-classification.js';
import type { SocialRelationshipKind } from './types.js';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import type { FakePostgresPool } from '../../test-support/fake-postgres-contact-pool.js';

const PRIMARY_USER_ID = 'discord-primary-123';

describe('Postgres contact social-graph consistency (E4.3)', () => {
  let pool: FakePostgresPool;
  let store: ContactStorePort;
  let entityIds: string[];

  async function makeEntities(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const contact = await store.upsert({
        displayName: `P${index}`,
        discordUserId: `p-${index}`,
      });
      const entity = await store.getSocialGraphEntityByContactId(contact.id);
      if (!entity) throw new Error(`Missing graph entity for ${contact.id}`);
      ids.push(entity.id);
    }
    return ids;
  }

  function allRows() {
    return [...pool.socialRelationshipEdges.values()];
  }

  function assertConsistent(): void {
    const rows = allRows();
    const keys = rows.map(row => [
      row.source_entity_id,
      row.target_entity_id,
      row.relationship_type,
      row.directional,
    ].join('|'));
    expect(new Set(keys).size).toBe(keys.length);

    for (const row of rows) {
      const kind = row.relationship_type as SocialRelationshipKind;
      const classification = classifySocialRelationship(kind);
      if (classification.directionality === 'symmetric') {
        expect(row.directional).toBe(false);
        expect(row.source_entity_id < row.target_entity_id).toBe(true);
        continue;
      }
      if (classification.directionality === 'inverse_pair') {
        expect(row.directional).toBe(true);
        const mirror = rows.find(candidate => (
          candidate.source_entity_id === row.target_entity_id
          && candidate.target_entity_id === row.source_entity_id
          && candidate.relationship_type === inverseRelationshipKind(kind)
          && candidate.directional
        ));
        expect(mirror).toBeDefined();
        expect(mirror?.confidence).toBe(row.confidence);
        expect([...(mirror?.evidence_memory_ids ?? [])].sort()).toEqual(
          [...row.evidence_memory_ids].sort(),
        );
        expect([...(mirror?.provenance_refs ?? [])].sort()).toEqual(
          [...row.provenance_refs].sort(),
        );
      }
    }
  }

  beforeEach(async () => {
    ({ pool, store } = await createTestPostgresContactStore(PRIMARY_USER_ID));
    entityIds = await makeEntities(5);
  });

  describe('upsert enforcement', () => {
    it('normalizes a symmetric type written directional:true to one canonical undirected edge', async () => {
      const [a, b] = entityIds;
      const edge = await store.upsertSocialRelationshipEdge({
        sourceEntityId: b > a ? b : a,
        targetEntityId: b > a ? a : b,
        relationshipType: 'friend',
        directional: true,
      });

      const [low, high] = [a, b].sort();
      expect(edge.directional).toBe(false);
      expect(edge.sourceEntityId).toBe(low);
      expect(edge.targetEntityId).toBe(high);
      expect(allRows()).toHaveLength(1);
      assertConsistent();
    });

    it('maintains a linked child mirror when a parent edge is written', async () => {
      const [a, b] = entityIds;
      const parent = await store.upsertSocialRelationshipEdge({
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
      const child = rows.find(row => row.relationship_type === 'child');
      expect(child).toMatchObject({
        source_entity_id: b,
        target_entity_id: a,
        directional: true,
      });
      assertConsistent();
    });

    it('propagates confidence and evidence updates across an inverse pair', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'manager',
        directional: true,
        confidence: 0.5,
        evidenceMemoryIds: ['e1'],
        provenanceRefs: ['p1'],
      });
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: b,
        targetEntityId: a,
        relationshipType: 'direct_report',
        directional: true,
        confidence: 0.9,
        evidenceMemoryIds: ['e2'],
        provenanceRefs: ['p2'],
      });

      const rows = allRows();
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.confidence === 0.9)).toBe(true);
      expect(rows.every(row => [...row.evidence_memory_ids].sort().join() === 'e1,e2')).toBe(true);
      expect(rows.every(row => [...row.provenance_refs].sort().join() === 'p1,p2')).toBe(true);
      assertConsistent();
    });

    it('stores a genuinely directional caregiver edge with no mirror', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'caregiver',
        directional: true,
      });

      expect(allRows()).toHaveLength(1);
      expect(allRows()[0]).toMatchObject({
        source_entity_id: a,
        target_entity_id: b,
        relationship_type: 'caregiver',
        directional: true,
      });
      assertConsistent();
    });
  });

  describe('write-time edge hygiene', () => {
    it('normalizes a symmetric directional request before it reaches storage', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'partner',
        directional: true,
      });

      expect(allRows()).toHaveLength(1);
      expect(allRows()[0]?.directional).toBe(false);
      assertConsistent();
    });

    it('creates an inverse mirror with shared evidence in the same active write', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'parent',
        evidenceMemoryIds: ['ev'],
      });

      const rows = allRows();
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.relationship_type).sort()).toEqual(['child', 'parent']);
      expect(rows.every(row => row.evidence_memory_ids.join() === 'ev')).toBe(true);
      assertConsistent();
    });

    it('collapses duplicate pair writes and unions their evidence', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'friend',
        confidence: 0.4,
        evidenceMemoryIds: ['a'],
      });
      const updated = await store.upsertSocialRelationshipEdge({
        sourceEntityId: b,
        targetEntityId: a,
        relationshipType: 'friend',
        confidence: 0.9,
        evidenceMemoryIds: ['b'],
      });

      expect(allRows()).toHaveLength(1);
      expect(updated.confidence).toBe(0.9);
      expect(updated.evidenceMemoryIds.sort()).toEqual(['a', 'b']);
      assertConsistent();
    });

    it('reorders a non-canonical undirected request before storing it', async () => {
      const [a, b] = entityIds.slice().sort();
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: b,
        targetEntityId: a,
        relationshipType: 'acquaintance',
        directional: false,
      });

      expect(allRows()[0]).toMatchObject({
        source_entity_id: a,
        target_entity_id: b,
        directional: false,
      });
      assertConsistent();
    });

    it('normalizes an inverse-pair request marked undirected into two directional rows', async () => {
      const [a, b] = entityIds;
      const parent = await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'parent',
        directional: false,
      });

      expect(parent.directional).toBe(true);
      expect(allRows()).toHaveLength(2);
      assertConsistent();
    });

    it('keeps genuinely directional kinds separate without inventing a mirror', async () => {
      const [a, b] = entityIds;
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'caregiver',
        directional: true,
      });
      await store.upsertSocialRelationshipEdge({
        sourceEntityId: b,
        targetEntityId: a,
        relationshipType: 'other',
        directional: true,
      });

      expect(allRows()).toHaveLength(2);
      expect(allRows().map(row => row.relationship_type).sort()).toEqual(['caregiver', 'other']);
      assertConsistent();
    });

    it('is idempotent when the same relationship write is repeated', async () => {
      const [a, b] = entityIds;
      const input = {
        sourceEntityId: a,
        targetEntityId: b,
        relationshipType: 'friend' as const,
        directional: true,
        evidenceMemoryIds: ['stable-evidence'],
      };
      const first = await store.upsertSocialRelationshipEdge(input);
      const second = await store.upsertSocialRelationshipEdge(input);

      expect(second.id).toBe(first.id);
      expect(allRows()).toHaveLength(1);
      expect(allRows()[0]?.evidence_memory_ids).toEqual(['stable-evidence']);
      assertConsistent();
    });
  });

  describe('property: public upserts preserve the graph invariants', () => {
    it('stays consistent under a deterministic pseudo-random write sequence', async () => {
      const kinds: SocialRelationshipKind[] = [
        'friend', 'partner', 'sibling', 'household', 'colleague', 'acquaintance', 'family',
        'parent', 'child', 'manager', 'direct_report', 'caregiver', 'other',
      ];
      let seed = 1_234_567;
      const random = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };

      for (let step = 0; step < 300; step += 1) {
        let sourceIndex = Math.floor(random() * entityIds.length);
        let targetIndex = Math.floor(random() * entityIds.length);
        if (sourceIndex === targetIndex) targetIndex = (targetIndex + 1) % entityIds.length;
        const kind = kinds[Math.floor(random() * kinds.length)]!;
        await store.upsertSocialRelationshipEdge({
          sourceEntityId: entityIds[sourceIndex]!,
          targetEntityId: entityIds[targetIndex]!,
          relationshipType: kind,
          directional: random() > 0.5,
          confidence: random(),
          evidenceMemoryIds: [`m-${step}`],
        });
        assertConsistent();
      }
    });
  });
});
