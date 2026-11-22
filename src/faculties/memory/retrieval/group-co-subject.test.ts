import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import { createGroupConversationScope } from '../../../core/session/conversation-scope.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import { MemoryRetriever } from '../retrieval.js';
import type { PurrMemory } from '../types.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';

function makeVector(seed: number): Float32Array {
  return new Float32Array([seed, 1 - seed, 0.5, 0.25]);
}

function makeMemory(overrides: Partial<PurrMemory> & { id: string; text: string }): PurrMemory {
  const recentMs = Date.now() - 60_000;
  return {
    type: 'semantic',
    sourceType: 'conversation',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0.2,
    salience: 0.7,
    sourceRef: `memory:${overrides.id}`,
    extractedAt: recentMs,
    lastAccessed: recentMs,
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    consentFlags: { allowRecall: true },
    embedding: makeVector(0.9),
    ...overrides,
  };
}

describe('MemoryRetriever group co-subject and shared_room recall', () => {
  it('recalls shared_room memories for present group participants while blocking third-party private DMs', async () => {
    const sharedRoomId = 'discord:guild:art-club';
    const store = new InMemoryMemoryStore();
    const sharedRoomMemory = makeMemory({
      id: 'mem-shared-room',
      text: 'The group agreed to sketch harbor cranes on Saturday morning.',
      sensitivity: 'personal',
      provenance: {
        channelId: sharedRoomId,
        addressMode: 'overheard_room_context',
        subjectContactIds: ['contact-bob', 'contact-carol'],
      },
      scopeRef: { kind: 'conversation', id: sharedRoomId },
    });
    const bobPrivateDmMemory = makeMemory({
      id: 'mem-bob-dm-secret',
      text: 'PRIVATE-DM-SECRET Bob confided his Saturday sketching plan in a private DM.',
      contactId: 'contact-bob',
      sensitivity: 'personal',
      provenance: {
        channelId: 'discord:dm:bob',
        subjectContactId: 'contact-bob',
      },
      scopeRef: { kind: 'conversation', id: 'discord:dm:bob' },
    });
    const bobUnprovenRoomMemory = makeMemory({
      id: 'mem-bob-no-room',
      text: 'PRIVATE-UNPROVEN-ROOM Bob mentioned his Saturday sketching address.',
      contactId: 'contact-bob',
      sensitivity: 'personal',
      provenance: {
        subjectContactId: 'contact-bob',
      },
    });
    const aliceOwnRoomMemory = makeMemory({
      id: 'mem-alice-room',
      text: 'Alice plans to bring charcoal pencils for Saturday sketching at the art club.',
      contactId: 'contact-alice',
      sensitivity: 'personal',
      provenance: {
        channelId: sharedRoomId,
        subjectContactId: 'contact-alice',
      },
      scopeRef: { kind: 'conversation', id: sharedRoomId },
    });

    const embedding = makeVector(0.9);
    store.insertMemory(sharedRoomMemory, embedding);
    store.insertMemory(bobPrivateDmMemory, embedding);
    store.insertMemory(bobUnprovenRoomMemory, embedding);
    store.insertMemory(aliceOwnRoomMemory, embedding);

    const contactsById = new Map<string, Contact>([
      ['contact-alice', {
        id: 'contact-alice',
        displayName: 'Alice',
        trustLevel: 'trusted',
        relationshipType: 'friend',
        firstSeen: '2025-01-01T00:00:00.000Z',
        lastSeen: '2026-09-10T10:00:00.000Z',
      }],
      ['contact-bob', {
        id: 'contact-bob',
        displayName: 'Bob',
        trustLevel: 'trusted',
        relationshipType: 'friend',
        firstSeen: '2025-01-01T00:00:00.000Z',
        lastSeen: '2026-09-10T10:00:00.000Z',
      }],
    ]);
    const contactStore = fromPartial<ContactStorePort>({
      getById: async id => contactsById.get(id),
      getByChannelIdentity: async (_source, externalId) => (
        externalId === 'discord-bob' ? contactsById.get('contact-bob') : undefined
      ),
      listRoomRoster: async () => [],
    });

    const embeddingService = fromPartial<EmbeddingProviderPort>({
      dims: 4,
      embed: async () => embedding,
    });

    const retriever = new MemoryRetriever(
      store.asPort(),
      embeddingService,
      {
        contactStore,
        retrievalThreshold: 0.1,
      },
    );

    const output = await retriever.retrieve(
      'What did we plan for Saturday sketching?',
      sharedRoomId,
      'trusted',
      { isDirectMessage: false, privacyLevel: 'invite_only' },
      'contact-alice',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createGroupConversationScope({
        channelId: sharedRoomId,
        recentSpeakers: [
          { authorId: 'contact-alice', name: 'Alice' },
          { authorId: 'discord-bob', name: 'Bob' },
        ],
      }),
    );

    // Shared-room memory involving co-subject Bob + Alice's room memory are recalled.
    expect(output).toContain('sketch harbor cranes');
    expect(output).toContain('charcoal pencils');

    // Bob's private DM memory and unproven-room memory NEVER leak into the group room.
    expect(output).not.toContain('PRIVATE-DM-SECRET');
    expect(output).not.toContain('PRIVATE-UNPROVEN-ROOM');
  });
});
