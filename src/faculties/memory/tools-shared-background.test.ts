import { describe, expect, it } from 'vitest';
import { createMemoryTool } from './tools.js';
import type { MemoryWriter } from './writer.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { PurrMemory } from './types.js';
import type { Contact, SocialGraphEntity } from '../../core/contacts/types.js';
import type { ConsentFlags, SensitivityLevel } from '../../system/trust/types.js';
import { createSharedBackgroundProvider } from './retrieval/shared-background.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

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

function makeFixtureTool() {
  const contactA = makeContact('contact-a', 'Ada', ['room:shared']);
  const contactB = makeContact('contact-b', 'Bosco', ['room:shared']);
  const memories: PurrMemory[] = [
    makeMemory({ id: 'mem-evidence', text: 'A and B met at the conference' }),
    makeMemory({
      id: 'mem-room',
      text: 'overheard exchange in the shared room',
      provenance: { channelId: 'room:shared' },
    }),
  ];
  const entities = { a: makeEntity('ent-a', 'contact-a'), b: makeEntity('ent-b', 'contact-b') };
  const provider = createSharedBackgroundProvider({
    memoryStore: {
      getById: async (id: string) => memories.find(m => m.id === id),
      listMemories: async () => memories,
    },
    contactStore: {
      getById: async (id: string) => (id === 'contact-a' ? contactA : id === 'contact-b' ? contactB : undefined),
      getSocialGraphEntityByContactId: async (contactId: string) =>
        Object.values(entities).find(e => e.contactId === contactId),
      listSocialRelationshipEdges: async () => [
        { sourceEntityId: 'ent-a', targetEntityId: 'ent-b', evidenceMemoryIds: ['mem-evidence'] },
      ],
    },
  });
  const writer = {} as unknown as MemoryWriter;
  const store = { searchByText: async () => [] } as unknown as MemoryStorePort;
  return createMemoryTool(writer, store, { sharedBackgroundProvider: provider });
}

describe('memory tool action=shared_background', () => {
  it('returns the evidence-ranked visible set with provenance labels for a high-trust context', async () => {
    const tool = makeFixtureTool();
    const result = await tool.execute('call-1', {
      action: 'shared_background',
      contact_a: 'contact-a',
      contact_b: 'contact-b',
      channel_id: 'api:dm',
      trust_level: 'primary',
      channel_visibility: 'private',
    });
    const text = resultText(result as any);
    expect(text).toContain('Shared background between Ada and Bosco:');
    expect(text).toContain('[edge-evidence]');
    expect(text).toContain('A and B met at the conference');
    expect(text).toContain('[shared-room]');
    // Edge-evidence ranks first.
    expect(text.indexOf('[edge-evidence]')).toBeLessThan(text.indexOf('[shared-room]'));
  });

  it('withholds with reason codes from a low-trust public context', async () => {
    const tool = makeFixtureTool();
    const result = await tool.execute('call-2', {
      action: 'shared_background',
      contact_a: 'contact-a',
      contact_b: 'contact-b',
      channel_id: 'api:public',
      trust_level: 'public',
      channel_visibility: 'public',
    });
    const text = resultText(result as any);
    expect(text).toContain('No shared-background memories are visible');
    expect(text).toContain('Withheld context: 2');
    expect(text).toContain('trust ceiling');
    // No memory bodies leak.
    expect(text).not.toContain('A and B met at the conference');
    expect(text).not.toContain('overheard exchange');
  });

  it('requires both contact ids', async () => {
    const tool = makeFixtureTool();
    const result = await tool.execute('call-3', {
      action: 'shared_background',
      contact_a: 'contact-a',
      channel_id: 'api:dm',
      trust_level: 'primary',
      channel_visibility: 'private',
    });
    const text = resultText(result as any);
    expect(text).toContain('contact_a and contact_b are both required');
  });

  it('fails closed when no provider is configured', async () => {
    const writer = {} as unknown as MemoryWriter;
    const store = {} as unknown as MemoryStorePort;
    const tool = createMemoryTool(writer, store);
    const result = await tool.execute('call-4', {
      action: 'shared_background',
      contact_a: 'contact-a',
      contact_b: 'contact-b',
      channel_id: 'api:dm',
      trust_level: 'primary',
      channel_visibility: 'private',
    });
    const text = resultText(result as any);
    expect(text).toContain('shared-background retrieval is not configured');
  });
});
