import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { Contact, SocialGraphEntity } from '../../../core/contacts/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import { AdminMemoryDataService } from './memory-service.js';

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `body-${id}`,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.6,
    sourceRef: `api:test:${id}`,
    extractedAt: Date.UTC(2026, 0, 5, 12, 0, 0),
    lastAccessed: Date.UTC(2026, 0, 5, 12, 0, 0),
    accessCount: 0,
    tags: [],
    sensitivity: 'personal' as SensitivityLevel,
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

function makeService() {
  const contactA = makeContact('contact-a', 'Ada', ['room:shared']);
  const contactB = makeContact('contact-b', 'Bosco', ['room:shared']);
  const memories: PurrMemory[] = [
    makeMemory('mem-evidence', { text: 'they met at the conference' }),
    makeMemory('mem-intimate', {
      text: 'a very private detail about them both',
      sensitivity: 'intimate',
      provenance: { sourceAuthorId: 'contact-a', subjectContactId: 'contact-b' },
    }),
  ];
  const entities = { a: makeEntity('ent-a', 'contact-a'), b: makeEntity('ent-b', 'contact-b') };
  const memoryStore = {
    getById: async (id: string) => memories.find(m => m.id === id),
    listMemories: async () => memories,
  } as unknown as MemoryStorePort;
  const contactStore = {
    listAll: async () => [contactA, contactB],
    getById: async (id: string) => (id === 'contact-a' ? contactA : id === 'contact-b' ? contactB : undefined),
    getSocialGraphEntityByContactId: async (contactId: string) =>
      Object.values(entities).find(e => e.contactId === contactId),
    listSocialRelationshipEdges: async () => [
      { sourceEntityId: 'ent-a', targetEntityId: 'ent-b', evidenceMemoryIds: ['mem-evidence'] },
    ],
  } as unknown as ContactStorePort;
  return new AdminMemoryDataService({ memoryStore, contactStore });
}

describe('AdminMemoryDataService.sharedBackground', () => {
  it('returns the union with sources and inherits E3.5 body redaction for intimate bodies', async () => {
    const service = makeService();
    const result = await service.sharedBackground('contact-a', 'contact-b');

    expect(result.resolved).toBe(true);
    expect(result.contactADisplayName).toBe('Ada');
    const byId = new Map(result.items.map(item => [item.memory.id, item]));
    expect([...byId.keys()].sort()).toEqual(['mem-evidence', 'mem-intimate']);
    expect(byId.get('mem-evidence')!.sources).toEqual(['edge_evidence']);
    expect(byId.get('mem-intimate')!.sources).toEqual(['co_mention']);

    // Non-intimate body is visible; intimate body is redacted (inherited).
    expect(byId.get('mem-evidence')!.memory.text).toBe('they met at the conference');
    const intimate = byId.get('mem-intimate')!.memory;
    expect(intimate.bodyRedacted).toBe(true);
    expect(intimate.text).not.toContain('a very private detail');
  });

  it('reveals intimate bodies after body-access elevation', async () => {
    const service = makeService();
    service.elevateBodyAccess();
    const result = await service.sharedBackground('contact-a', 'contact-b');
    const intimate = result.items.find(item => item.memory.id === 'mem-intimate')!.memory;
    expect(intimate.bodyRedacted).toBeUndefined();
    expect(intimate.text).toBe('a very private detail about them both');
  });

  it('bounds the result to the requested limit', async () => {
    const service = makeService();
    const result = await service.sharedBackground('contact-a', 'contact-b', 1);
    expect(result.items).toHaveLength(1);
    expect(result.limit).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
