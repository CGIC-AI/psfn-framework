import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Contact, SocialGraphEntity, SocialRelationshipEdge, SocialRelationshipEdgeQuery } from '../../../core/contacts/types.js';
import type { PurrMemory } from '../types.js';
import {
  SocialGraphBuilderWorker,
  createSocialGraphBuilderMemoryReader,
  type SocialGraphBuilderMemoryReader,
} from './graph-builder-worker.js';
import {
  createFileSocialGraphProposalStore,
  createFileSocialGraphBuilderWatermarkStore,
  type SocialGraphProposalStore,
} from './proposals.js';

// ── Fixtures ──

function makeMemory(overrides: Partial<PurrMemory> & Pick<PurrMemory, 'id'>): PurrMemory {
  return {
    text: '',
    type: 'relational',
    importance: 0.5,
    confidence: 0.7,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: 'source:test',
    extractedAt: 1_000,
    lastAccessed: 1_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  } as PurrMemory;
}

interface StubContacts {
  getById(id: string): Promise<Contact | undefined>;
  getSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined>;
  listSocialRelationshipEdges(query?: SocialRelationshipEdgeQuery): Promise<SocialRelationshipEdge[]>;
}

function makeContact(id: string, displayName: string): Contact {
  return {
    id,
    displayName,
    trustLevel: 'personal',
    relationshipType: 'acquaintance',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-02T00:00:00.000Z',
  };
}

function makeEntity(contactId: string, displayName: string): SocialGraphEntity {
  return {
    id: `contact:${contactId}`,
    entityKind: 'person',
    displayName,
    contactId,
    sensitivity: 'personal',
    provenanceRefs: [],
    confidence: 1,
    source: 'contact',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeStubContacts(options: {
  tracked: Map<string, Contact>;
  entities?: Map<string, SocialGraphEntity>;
  edges?: SocialRelationshipEdge[];
}): StubContacts {
  const entities = options.entities ?? new Map();
  const edges = options.edges ?? [];
  return {
    async getById(id) {
      return options.tracked.get(id);
    },
    async getSocialGraphEntityByContactId(contactId) {
      return entities.get(contactId);
    },
    async listSocialRelationshipEdges(query) {
      const entityId = query?.entityId;
      if (!entityId) return edges;
      return edges.filter(edge => edge.sourceEntityId === entityId || edge.targetEntityId === entityId);
    },
  };
}

function makeReader(memories: PurrMemory[]): SocialGraphBuilderMemoryReader {
  // Ignores sinceMs so a re-run rescans the same evidence (exercises dedup).
  return {
    async listRoomScopedMemoriesSince() {
      return memories;
    },
  };
}

const ALICE = 'c-alice';
const BOB = 'c-bob';
const GHOST = 'c-ghost';

function trackedAliceBob(): Map<string, Contact> {
  return new Map([
    [ALICE, makeContact(ALICE, 'Alice')],
    [BOB, makeContact(BOB, 'Bob')],
  ]);
}

/** 3 co-presence sessions between Alice and Bob in room-1. */
function coPresenceMemories(): PurrMemory[] {
  const memories: PurrMemory[] = [];
  for (let i = 1; i <= 3; i += 1) {
    memories.push(makeMemory({
      id: `cp-alice-${i}`,
      text: 'chatting in the room',
      extractedAt: 1_000 + i,
      provenance: { channelId: 'room-1', sessionId: `s${i}`, sourceContactId: ALICE, addressMode: 'reply_to_user' },
    }));
    memories.push(makeMemory({
      id: `cp-bob-${i}`,
      text: 'chatting in the room',
      extractedAt: 1_100 + i,
      provenance: { channelId: 'room-1', sessionId: `s${i}`, sourceContactId: BOB, addressMode: 'reply_to_user' },
    }));
  }
  return memories;
}

let tmpRoot: string;
let proposalStore: SocialGraphProposalStore;
let watermarkPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-builder-'));
  proposalStore = createFileSocialGraphProposalStore(join(tmpRoot, 'proposals.json'));
  watermarkPath = join(tmpRoot, 'watermark.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SocialGraphBuilderWorker', () => {
  it('AC1: proposes co-presence + overheard edges with evidence links; re-run is idempotent', async () => {
    const overheard = makeMemory({
      id: 'ov-1',
      text: 'Bob is Alice\'s sister',
      extractedAt: 2_000,
      provenance: {
        channelId: 'room-1',
        addressMode: 'overheard_room_context',
        sourceContactId: ALICE,
        subjectContactId: BOB,
      },
    });
    const worker = new SocialGraphBuilderWorker({
      memoryReader: makeReader([...coPresenceMemories(), overheard]),
      contacts: makeStubContacts({ tracked: trackedAliceBob() }),
      proposalStore,
      watermarkStore: createFileSocialGraphBuilderWatermarkStore(watermarkPath),
    });

    const first = await worker.run();
    expect(first.proposed).toBe(2);
    expect(first.conflicts).toBe(0);
    expect(first.skippedUntracked).toBe(0);

    const proposals = await proposalStore.list();
    expect(proposals).toHaveLength(2);
    const coPresence = proposals.find(p => p.evidenceClass === 'co_presence');
    const overheardProposal = proposals.find(p => p.evidenceClass === 'overheard_interaction');
    expect(coPresence).toBeDefined();
    expect(coPresence?.relationshipType).toBe('acquaintance');
    expect(coPresence?.directional).toBe(false);
    expect(coPresence?.confidence).toBeCloseTo(0.5);
    expect(coPresence?.evidenceMemoryIds.length).toBeGreaterThanOrEqual(6);
    expect(overheardProposal?.relationshipType).toBe('family');
    expect(overheardProposal?.confidence).toBeCloseTo(0.6);
    expect(overheardProposal?.evidenceMemoryIds).toEqual(['ov-1']);
    expect(new Set([coPresence?.sourceContactId, coPresence?.targetContactId])).toEqual(new Set([ALICE, BOB]));

    // Re-run from the same evidence -> zero new proposals (dedup by evidence hash).
    const second = await worker.run();
    expect(second.proposed).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(second.deduped).toBeGreaterThanOrEqual(2);
    expect(await proposalStore.list()).toHaveLength(2);
  });

  it('AC2: an operator-set edge survives a conflicting proposal (conflict lands in review, edge untouched)', async () => {
    const operatorEdge: SocialRelationshipEdge = {
      id: 'edge:operator-1',
      sourceEntityId: `contact:${ALICE}`,
      targetEntityId: `contact:${BOB}`,
      relationshipType: 'partner',
      directional: false,
      sensitivity: 'personal',
      provenanceRefs: ['source:manual'],
      evidenceMemoryIds: [],
      confidence: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const edges = [operatorEdge];
    const named = makeMemory({
      id: 'named-1',
      text: 'my sister Bob',
      extractedAt: 3_000,
      provenance: {
        channelId: 'room-1',
        addressMode: 'reply_to_user',
        sourceContactId: ALICE,
        subjectContactId: BOB,
      },
    });
    const worker = new SocialGraphBuilderWorker({
      memoryReader: makeReader([named]),
      contacts: makeStubContacts({
        tracked: trackedAliceBob(),
        entities: new Map([
          [ALICE, makeEntity(ALICE, 'Alice')],
          [BOB, makeEntity(BOB, 'Bob')],
        ]),
        edges,
      }),
      proposalStore,
      watermarkStore: createFileSocialGraphBuilderWatermarkStore(watermarkPath),
    });

    const result = await worker.run();
    expect(result.conflicts).toBe(1);
    expect(result.proposed).toBe(0);

    const proposals = await proposalStore.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('conflict');
    expect(proposals[0].relationshipType).toBe('sibling');
    expect(proposals[0].conflictEdgeId).toBe('edge:operator-1');
    expect(proposals[0].conflictEdgeType).toBe('partner');
    // Original operator edge is untouched (worker never writes edges).
    expect(edges).toEqual([operatorEdge]);
  });

  it('AC3: an untracked speaker produces zero graph rows / proposals', async () => {
    const overheardWithGhostSubject = makeMemory({
      id: 'ov-ghost',
      text: 'Ghost is Alice\'s friend',
      extractedAt: 4_000,
      provenance: {
        channelId: 'room-1',
        addressMode: 'overheard_room_context',
        sourceContactId: ALICE,
        subjectContactId: GHOST, // NOT tracked
      },
    });
    // Ghost co-present with Alice across 3 sessions, but Ghost has no contact row.
    const ghostCoPresence: PurrMemory[] = [];
    for (let i = 1; i <= 3; i += 1) {
      ghostCoPresence.push(makeMemory({
        id: `ghost-a-${i}`,
        extractedAt: 5_000 + i,
        provenance: { channelId: 'room-2', sessionId: `g${i}`, sourceContactId: ALICE, addressMode: 'reply_to_user' },
      }));
      ghostCoPresence.push(makeMemory({
        id: `ghost-g-${i}`,
        extractedAt: 5_100 + i,
        provenance: { channelId: 'room-2', sessionId: `g${i}`, sourceContactId: GHOST, addressMode: 'reply_to_user' },
      }));
    }
    const worker = new SocialGraphBuilderWorker({
      memoryReader: makeReader([overheardWithGhostSubject, ...ghostCoPresence]),
      contacts: makeStubContacts({ tracked: trackedAliceBob() }), // Ghost absent => untracked
      proposalStore,
      watermarkStore: createFileSocialGraphBuilderWatermarkStore(watermarkPath),
    });

    const result = await worker.run();
    expect(result.proposed).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.skippedUntracked).toBeGreaterThanOrEqual(2);
    const proposals = await proposalStore.list();
    expect(proposals).toHaveLength(0);
    // No proposal references the untracked speaker.
    expect(proposals.some(p => p.sourceContactId === GHOST || p.targetContactId === GHOST)).toBe(false);
  });

  it('proposes a typed bidirectional named-relationship edge (my sister)', async () => {
    const named = makeMemory({
      id: 'named-sib',
      text: 'my sister Bob came over',
      extractedAt: 6_000,
      provenance: {
        channelId: 'room-1',
        addressMode: 'reply_to_user',
        sourceContactId: ALICE,
        subjectContactId: BOB,
      },
    });
    const worker = new SocialGraphBuilderWorker({
      memoryReader: makeReader([named]),
      contacts: makeStubContacts({ tracked: trackedAliceBob() }),
      proposalStore,
      watermarkStore: createFileSocialGraphBuilderWatermarkStore(watermarkPath),
    });
    await worker.run();
    const proposals = await proposalStore.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].relationshipType).toBe('sibling');
    expect(proposals[0].directional).toBe(false);
    expect(proposals[0].confidence).toBeCloseTo(0.7);
  });

  it('reader scans oldest unprocessed room memories when a channel exceeds the scan limit', async () => {
    // A channel with more room memories than the scan limit. getMemoriesByChannel
    // returns the NEWEST `limit` (extractedAt DESC) — a single capped call would
    // only ever see the newest window, and advancing the watermark to that batch
    // max would strand the older unprocessed memories forever.
    const total = 620;
    const scanLimit = 500;
    const roomMemories: PurrMemory[] = [];
    for (let i = 1; i <= total; i += 1) {
      roomMemories.push(makeMemory({
        id: `m-${String(i).padStart(4, '0')}`,
        extractedAt: i,
        provenance: { channelId: 'room-1', addressMode: 'reply_to_user', sourceContactId: ALICE },
      }));
    }
    const getMemoriesByChannel = async (channelId: string, limit: number): Promise<PurrMemory[]> => (
      channelId === 'room-1'
        ? [...roomMemories].sort((a, b) => b.extractedAt - a.extractedAt).slice(0, limit)
        : []
    );
    const reader = createSocialGraphBuilderMemoryReader({
      listRoomChannelIds: async () => ['room-1'],
      getMemoriesByChannel,
    });

    // First run: the oldest unprocessed memories are returned (ascending), not
    // the newest window.
    const firstBatch = await reader.listRoomScopedMemoriesSince(0, scanLimit);
    expect(firstBatch).toHaveLength(scanLimit);
    expect(firstBatch[0].extractedAt).toBe(1);
    expect(firstBatch.at(-1)?.extractedAt).toBe(scanLimit);
    // The newest memory must NOT be in the first batch (it is not stranded — it
    // is simply processed later, oldest-first).
    expect(firstBatch.some(memory => memory.extractedAt === total)).toBe(false);

    // Second run after advancing the watermark to the first batch's max: the
    // remaining (newer) memories are picked up. No memory is stranded.
    const watermark = firstBatch.reduce((max, memory) => Math.max(max, memory.extractedAt), 0);
    const secondBatch = await reader.listRoomScopedMemoriesSince(watermark, scanLimit);
    expect(secondBatch).toHaveLength(total - scanLimit);
    expect(secondBatch[0].extractedAt).toBe(scanLimit + 1);
    expect(secondBatch.at(-1)?.extractedAt).toBe(total);

    const covered = new Set([...firstBatch, ...secondBatch].map(memory => memory.extractedAt));
    expect(covered.size).toBe(total);
  });

  it('proposes a single-direction edge for an asymmetric named relationship (my mom)', async () => {
    const named = makeMemory({
      id: 'named-mom',
      text: 'my mom Bob',
      extractedAt: 7_000,
      provenance: {
        channelId: 'room-1',
        addressMode: 'reply_to_user',
        sourceContactId: ALICE,
        subjectContactId: BOB,
      },
    });
    const worker = new SocialGraphBuilderWorker({
      memoryReader: makeReader([named]),
      contacts: makeStubContacts({ tracked: trackedAliceBob() }),
      proposalStore,
      watermarkStore: createFileSocialGraphBuilderWatermarkStore(watermarkPath),
    });
    await worker.run();
    const proposals = await proposalStore.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].relationshipType).toBe('parent');
    expect(proposals[0].directional).toBe(true);
    expect(proposals[0].sourceContactId).toBe(ALICE);
    expect(proposals[0].targetContactId).toBe(BOB);
  });
});
