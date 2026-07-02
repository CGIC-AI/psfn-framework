import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../types.js';
import type { Contact, SocialGraphEntity } from '../../../core/contacts/types.js';
import type { ConsentFlags, SensitivityLevel } from '../../../system/trust/types.js';
import {
  collectSharedBackgroundUnion,
  computeSharedBackground,
  type SharedBackgroundAccessOptions,
  type SharedBackgroundDeps,
} from './shared-background.js';

// ── Fixtures ──

function makeMemory(overrides: Partial<PurrMemory> & { id: string }): PurrMemory {
  return {
    id: overrides.id,
    text: `text-${overrides.id}`,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: `test:${overrides.id}`,
    extractedAt: 1_000,
    lastAccessed: 1_000,
    accessCount: 1,
    tags: [],
    sensitivity: 'personal' as SensitivityLevel,
    consentFlags: {} as ConsentFlags,
    ...overrides,
  };
}

function makeContact(id: string, displayName: string, roomIds: string[]): Contact {
  return {
    id,
    displayName,
    trustLevel: 'regular',
    relationshipType: 'friend',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-02T00:00:00.000Z',
    conversationChannels: roomIds.map(channelId => ({
      channel: 'api',
      channelId,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-02T00:00:00.000Z',
    })),
  } as Contact;
}

function makeEntity(id: string, contactId: string): SocialGraphEntity {
  return {
    id,
    entityKind: 'person',
    displayName: contactId,
    contactId,
    sensitivity: 'personal',
    provenanceRefs: [],
    confidence: 0.9,
    source: 'inferred',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as SocialGraphEntity;
}

interface FixtureOptions {
  memories: PurrMemory[];
  contacts: Record<string, Contact>;
  entities: Record<string, SocialGraphEntity>;
  edges: Array<{ sourceEntityId: string; targetEntityId: string; evidenceMemoryIds: string[] }>;
}

function makeDeps(fixture: FixtureOptions): SharedBackgroundDeps {
  return {
    memoryStore: {
      getById: async (id: string) => fixture.memories.find(m => m.id === id),
      listMemories: async () => fixture.memories,
    },
    contactStore: {
      getById: async (id: string) => fixture.contacts[id],
      getSocialGraphEntityByContactId: async (contactId: string) =>
        Object.values(fixture.entities).find(e => e.contactId === contactId),
      listSocialRelationshipEdges: async () => fixture.edges,
    },
  };
}

const HIGH_TRUST: SharedBackgroundAccessOptions = {
  trustLevel: 'primary',
  channelPrivacy: 'private',
  broadcast: false,
};

const LOW_TRUST: SharedBackgroundAccessOptions = {
  trustLevel: 'public',
  channelPrivacy: 'public',
  broadcast: false,
};

function baseFixture(): FixtureOptions {
  const contactA = makeContact('contact-a', 'Ada', ['room:shared']);
  const contactB = makeContact('contact-b', 'Bosco', ['room:shared']);
  return {
    contacts: { 'contact-a': contactA, 'contact-b': contactB },
    entities: { a: makeEntity('ent-a', 'contact-a'), b: makeEntity('ent-b', 'contact-b') },
    edges: [
      { sourceEntityId: 'ent-a', targetEntityId: 'ent-b', evidenceMemoryIds: ['mem-evidence'] },
    ],
    memories: [
      makeMemory({ id: 'mem-evidence', text: 'A and B met at the conference', salience: 0.4 }),
      makeMemory({
        id: 'mem-comention',
        text: 'A mentioned B fondly',
        salience: 0.9,
        provenance: { sourceAuthorId: 'contact-a', subjectContactId: 'contact-b' },
      }),
      makeMemory({
        id: 'mem-room',
        text: 'overheard exchange in the shared room',
        salience: 0.9,
        provenance: { channelId: 'room:shared' },
      }),
      // Noise: only names A, in an unrelated room — must NOT surface.
      makeMemory({
        id: 'mem-noise',
        text: 'A solo note',
        provenance: { sourceAuthorId: 'contact-a', channelId: 'room:other' },
      }),
    ],
  };
}

// ── AC1: union, provenance grouping, evidence-ranking ──

describe('collectSharedBackgroundUnion', () => {
  it('unions edge-evidence, co-mention, and shared-room with correct provenance grouping', async () => {
    const union = await collectSharedBackgroundUnion(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
    });

    expect(union.resolved).toBe(true);
    expect(union.contactADisplayName).toBe('Ada');
    expect(union.contactBDisplayName).toBe('Bosco');

    const byId = new Map(union.candidates.map(c => [c.memory.id, c]));
    expect([...byId.keys()].sort()).toEqual(['mem-comention', 'mem-evidence', 'mem-room']);
    expect(byId.get('mem-evidence')!.sources).toEqual(['edge_evidence']);
    expect(byId.get('mem-comention')!.sources).toEqual(['co_mention']);
    expect(byId.get('mem-room')!.sources).toEqual(['shared_room']);
    // Noise memory that names only A must not surface.
    expect(byId.has('mem-noise')).toBe(false);
  });

  it('ranks edge-evidence first even when its salience is lower', async () => {
    const union = await collectSharedBackgroundUnion(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
    });
    expect(union.candidates[0].memory.id).toBe('mem-evidence');
    expect(union.candidates[0].sources).toContain('edge_evidence');
  });

  it('accumulates multiple sources on one memory', async () => {
    const fixture = baseFixture();
    // A memory that is BOTH edge evidence and a co-mention.
    fixture.edges = [
      { sourceEntityId: 'ent-a', targetEntityId: 'ent-b', evidenceMemoryIds: ['mem-comention'] },
    ];
    const union = await collectSharedBackgroundUnion(makeDeps(fixture), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
    });
    const both = union.candidates.find(c => c.memory.id === 'mem-comention');
    expect(both?.sources).toEqual(['edge_evidence', 'co_mention']);
  });

  it('reports unresolved contacts without leaking a union', async () => {
    const fixture = baseFixture();
    const union = await collectSharedBackgroundUnion(makeDeps(fixture), {
      contactAId: 'contact-a',
      contactBId: 'contact-missing',
    });
    expect(union.resolved).toBe(false);
    expect(union.candidates).toEqual([]);
    expect(union.missingContactIds).toContain('contact-missing');
  });
});

// ── AC1/AC2: asking-context gating (both contexts) ──

describe('computeSharedBackground gating', () => {
  it('returns the evidence-ranked set for a high-trust asking context', async () => {
    const result = await computeSharedBackground(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
      access: HIGH_TRUST,
    });
    expect(result.items.map(i => i.memory.id)).toEqual(['mem-evidence', 'mem-comention', 'mem-room']);
    expect(result.withheldSummary).toBeUndefined();
    expect(result.totalCandidates).toBe(3);
  });

  it('withholds everything with reason codes from a low-trust public context', async () => {
    const result = await computeSharedBackground(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
      access: LOW_TRUST,
    });
    expect(result.items).toEqual([]);
    expect(result.withheldSummary?.totalCount).toBe(3);
    expect(result.withheldSummary?.reasonCounts['trust.ceiling_exceeded']).toBe(3);
  });

  it('lets a low-trust public context see only public shared background', async () => {
    const fixture = baseFixture();
    // Make the shared-room memory public: a low-trust room could see it anyway.
    fixture.memories = fixture.memories.map(m =>
      m.id === 'mem-room' ? { ...m, sensitivity: 'public' as SensitivityLevel } : m);
    const result = await computeSharedBackground(makeDeps(fixture), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
      access: LOW_TRUST,
    });
    expect(result.items.map(i => i.memory.id)).toEqual(['mem-room']);
    expect(result.withheldSummary?.totalCount).toBe(2);
  });
});

// ── AC3: bounded top-K + truncation ──

describe('computeSharedBackground bounds', () => {
  it('bounds results to the requested limit and flags truncation', async () => {
    const result = await computeSharedBackground(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
      access: HIGH_TRUST,
      limit: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.limit).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.items[0].memory.id).toBe('mem-evidence');
  });

  it('caps an over-large requested limit to the hard maximum', async () => {
    const result = await computeSharedBackground(makeDeps(baseFixture()), {
      contactAId: 'contact-a',
      contactBId: 'contact-b',
      access: HIGH_TRUST,
      limit: 10_000,
    });
    expect(result.limit).toBe(25);
    expect(result.truncated).toBe(false);
  });
});
