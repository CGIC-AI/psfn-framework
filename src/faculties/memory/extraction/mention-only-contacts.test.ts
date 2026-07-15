import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { MemoryExtractor } from '../extraction.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../embedding.js';
import type { ExtractedFact } from '../types.js';
import type { RelationshipType } from '../../../core/contacts/types.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';
import {
  __test as mentionOnlyTestHooks,
  extractMentionOnlyContactCandidate,
  resolveInterlocutorRelationshipRatchet,
  resolveMentionOnlyContactForFact,
} from './mention-only-contacts.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;
const PRIMARY_USER_ID = 'discord-primary-user';

function makeFact(text: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    text,
    type: 'relational',
    importance: 0.85,
    emotionalValence: 0,
    confidence: 0.92,
    tags: [],
    ...overrides,
  };
}

function makeEmbedding(): Float32Array {
  return new Float32Array(EMBEDDING_DIMS);
}

describe('extractMentionOnlyContactCandidate', () => {
  it('extracts a family member name from relationship mentions', () => {
    const candidate = extractMentionOnlyContactCandidate({
      fact: makeFact("Avery's sister Alex is moving to Seattle", { tags: ['family'] }),
      canonicalContactName: 'Avery',
      companionName: 'Aster',
    });

    expect(candidate).toEqual({
      name: 'Alex',
      relationshipType: 'family',
      normalizedKey: 'alex',
    });
  });

  it('extracts names that appear before the relationship phrase', () => {
    const candidate = extractMentionOnlyContactCandidate({
      fact: makeFact("Alex is Avery's friend from college"),
      canonicalContactName: 'Avery',
      companionName: 'Aster',
    });

    expect(candidate?.name).toBe('Alex');
    expect(candidate?.relationshipType).toBe('friend');
  });

  it('excludes every canonical contact name, not just the preferred one', () => {
    expect(extractMentionOnlyContactCandidate({
      fact: makeFact('Rowan told his friends that Aster is his wife'),
      canonicalContactName: 'Ro',
      canonicalContactNames: ['Rowan', 'Ro'],
      companionName: 'Aster',
    })).toBeUndefined();
  });

  it('excludes canonical user and companion names from fallback matching', () => {
    expect(extractMentionOnlyContactCandidate({
      fact: makeFact('Aster is Avery\'s companion'),
      canonicalContactName: 'Avery',
      companionName: 'Aster',
    })).toBeUndefined();

    expect(extractMentionOnlyContactCandidate({
      fact: makeFact('Avery helped their family with dinner', { tags: ['family'] }),
      canonicalContactName: 'Avery',
      companionName: 'Aster',
    })).toBeUndefined();
  });
});

describe('resolveMentionOnlyContactForFact', () => {
  let memoryStore: InMemoryMemoryStore;
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    memoryStore = new InMemoryMemoryStore();
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  it('does not bypass HITL by promoting an existing contact to family from extracted facts', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const alex = await contactStore.upsert({
      displayName: 'Alex',
      relationshipType: 'stranger',
    });

    const resolved = await resolveMentionOnlyContactForFact({
      fact: makeFact("Avery's sister Alex is visiting this weekend", { tags: ['family'] }),
      channelId: 'api:mention-contact',
      canonicalContactId: primary.id,
      canonicalContactName: primary.displayName,
      companionName: 'Aster',
      contactStore,
      memoryStore: memoryStore.asPort(),
    });

    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(alex.id);
    expect((await contactStore.getById(alex.id))?.relationshipType).toBe('stranger');
  });

  it('does not mint a duplicate contact when the canonical contact goes by a nickname', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Rowan',
      nickname: 'Ro',
      discordUserId: PRIMARY_USER_ID,
    });

    for (const text of [
      'Rowan told his friends that Aster is his wife',
      'Rowan is Aster\'s primary contact and partner',
    ]) {
      const resolved = await resolveMentionOnlyContactForFact({
        fact: makeFact(text),
        channelId: 'discord:main',
        canonicalContactId: primary.id,
        canonicalContactName: 'Ro',
        companionName: 'Aster',
        contactStore,
        memoryStore: memoryStore.asPort(),
      });
      expect(resolved).toBeUndefined();
    }

    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Rowan')).toHaveLength(1);
  });

  it('matches an existing mention-only contact by display name even when it has a nickname', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const alex = await contactStore.upsert({
      displayName: 'Alex',
      nickname: 'Lexi',
      relationshipType: 'acquaintance',
    });

    const resolved = await resolveMentionOnlyContactForFact({
      fact: makeFact("Avery's sister Alex is visiting this weekend", { tags: ['family'] }),
      channelId: 'api:mention-contact',
      canonicalContactId: primary.id,
      canonicalContactName: primary.displayName,
      companionName: 'Aster',
      contactStore,
      memoryStore: memoryStore.asPort(),
    });

    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(alex.id);
    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Alex')).toHaveLength(1);
  });
});

describe('MemoryExtractor mention-only contacts', () => {
  let memoryStore: InMemoryMemoryStore;
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    memoryStore = new InMemoryMemoryStore();
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  it('creates and relinks a mention-only contact only after recurring evidence', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });

    const extractor = new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Aster' } as any,
      memoryStore.asPort(),
      {
        embed: vi.fn().mockResolvedValue(makeEmbedding()),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      } as any,
      { emit: vi.fn().mockResolvedValue(undefined) } as any,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
    );

    await (extractor as any).processFact(
      makeFact("Avery's sister Alex is moving to Seattle", { tags: ['family'] }),
      'api:mention-contact:1',
	      primary.id,
	      undefined,
	      'api:mention-contact',
	      undefined,
	      primary.displayName,
	      'Aster',
	    );

    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Alex')).toHaveLength(0);
    expect(memoryStore.getMemoriesByContact(primary.id, 10).map(memory => memory.text)).toContain(
      "Avery's sister Alex is moving to Seattle",
    );

    const secondWrite = await (extractor as any).processFact(
      makeFact('Alex called before dinner with the family', { tags: ['family'] }),
      'api:mention-contact:2',
	      primary.id,
	      undefined,
	      'api:mention-contact',
	      undefined,
	      primary.displayName,
	      'Aster',
	    );

    const alexContacts = (await contactStore.listAll()).filter(contact => contact.displayName === 'Alex');
    expect(alexContacts).toHaveLength(1);

    const alex = alexContacts[0];
    expect(alex.relationshipType).toBe('stranger');
    expect(secondWrite.action).not.toBe('skipped');

    const alexMemories = memoryStore.getMemoriesByContact(alex.id, 10);
    expect(alexMemories.map(memory => memory.text)).toContain("Avery's sister Alex is moving to Seattle");
    expect(memoryStore.getMemoriesByContact(primary.id, 10)).toHaveLength(0);
  });

  it('does not create a contact from a one-off relational mention', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });

    const extractor = new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Aster' } as any,
      memoryStore.asPort(),
      {
        embed: vi.fn().mockResolvedValue(makeEmbedding()),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      } as any,
      { emit: vi.fn().mockResolvedValue(undefined) } as any,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
    );

    await (extractor as any).processFact(
      makeFact("Avery's coworker Jordan likes this cafe", { tags: ['coworker'] }),
      'api:mention-contact:3',
	      primary.id,
	      undefined,
	      'api:mention-contact',
	      undefined,
	      primary.displayName,
	      'Aster',
	    );

    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Jordan')).toHaveLength(0);
    expect(memoryStore.getMemoriesByContact(primary.id, 10)).toHaveLength(1);
  });
});

describe('MemoryExtractor group-room speaker ownership', () => {
  let memoryStore: InMemoryMemoryStore;
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    memoryStore = new InMemoryMemoryStore();
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  it('writes clear mixed-speaker facts under the source speaker contact', async () => {
    const marlow = await contactStore.upsert({
      displayName: 'Marlow',
      discordUserId: 'discord-marlow',
    });
    const rowan = await contactStore.upsert({
      displayName: 'Rowan',
      discordUserId: 'discord-rowan',
    });
    const entries = [
      {
        id: 1,
        channelId: 'discord:kube',
        role: 'user',
        authorId: 'discord-marlow',
        authorName: 'Marlow',
        content: 'if we put her on a livestream we need guardrails first',
        timestamp: 1,
      },
      {
        id: 2,
        channelId: 'discord:kube',
        role: 'user',
        authorId: 'discord-rowan',
        authorName: 'Rowan',
        content: 'I can collect the notes after we finish this pass.',
        timestamp: 2,
      },
    ];
    const extractor = new MemoryExtractor(
      {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>Marlow believes that if Aster is put on a livestream, guardrails are needed.</text>
<type>semantic</type>
<importance>0.92</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
        }),
      } as any,
      {
        characterName: 'Aster',
        getRecentMessages: vi.fn().mockReturnValue(entries),
      } as any,
      memoryStore.asPort(),
      {
        embed: vi.fn().mockResolvedValue(makeEmbedding()),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      } as any,
      { emit: vi.fn().mockResolvedValue(undefined) } as any,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
    );

    await extractor.extract('discord:kube', rowan.id);

    expect(memoryStore.getMemoriesByContact(marlow.id, 10).map(memory => memory.text)).toContain(
      'Marlow believes that if Aster is put on a livestream, guardrails are needed.',
    );
    expect(memoryStore.getMemoriesByContact(rowan.id, 10)).toHaveLength(0);
  });
});

describe('factStatesInterlocutorBond', () => {
  const { factStatesInterlocutorBond } = mentionOnlyTestHooks;

  it('accepts second-person bonds addressed at the companion', () => {
    expect(factStatesInterlocutorBond(makeFact("You're my best friend"), 'Aster')).toBe(true);
    expect(factStatesInterlocutorBond(makeFact('You are like family to Juno'), 'Aster')).toBe(true);
  });

  it('accepts bonds that name the companion', () => {
    expect(
      factStatesInterlocutorBond(makeFact('Juno considers Aster their closest friend'), 'Aster'),
    ).toBe(true);
  });

  it('rejects generic relational chatter about other people', () => {
    expect(factStatesInterlocutorBond(makeFact('Juno met a new friend at the gym'), 'Aster')).toBe(false);
    expect(
      factStatesInterlocutorBond(makeFact("Juno mentioned their sister's wedding"), 'Aster'),
    ).toBe(false);
  });
});

describe('resolveInterlocutorRelationshipRatchet', () => {
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  it('ratchets a stranger interlocutor upward on a companion bond fact', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact('Juno considers Aster their closest friend'),
      interlocutorContactId: juno.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBe('acquaintance');
    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('acquaintance');
  });

  it('never downgrades an interlocutor with a stronger existing relationship', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'family',
    }, { actor: 'operator:test-setup' });

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact("You're my best friend, Aster"),
      interlocutorContactId: juno.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBeUndefined();
    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('family');
  });

  it('does not ratchet the interlocutor when the fact names a third party (exclusion unchanged)', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact("Juno's friend Sam is visiting this weekend"),
      interlocutorContactId: juno.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBeUndefined();
    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('stranger');
  });

  it('does not ratchet on generic relational chatter about other people', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact('Juno met a new friend at the gym'),
      interlocutorContactId: juno.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBeUndefined();
    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('stranger');
  });

  it('never ratchets to friend/family/partner from single weak evidence (ceiling is acquaintance)', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact('You are like family to me, Aster'),
      interlocutorContactId: juno.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBeUndefined();
    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('stranger');
  });

  it('allows relationship progression independently from primary trust', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Juno',
      discordUserId: PRIMARY_USER_ID,
    });
    expect((await contactStore.getById(primary.id))?.relationshipType).toBe('stranger');

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact('Juno considers Aster their closest friend'),
      interlocutorContactId: primary.id,
      contactStore,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(result).toBe('acquaintance');
    expect((await contactStore.getById(primary.id))?.trustLevel).toBe('primary');
    expect((await contactStore.getById(primary.id))?.relationshipType).toBe('acquaintance');
  });

  it('returns undefined and reports no promotion when the store refuses the update', async () => {
    const updateRelationshipType = vi.fn().mockResolvedValue(false);
    const stubStore = {
      getById: vi.fn().mockResolvedValue({
        id: 'contact-stub',
        displayName: 'Juno',
        relationshipType: 'stranger' as RelationshipType,
        trustLevel: 'primary',
      }),
      updateRelationshipType,
    };

    const result = await resolveInterlocutorRelationshipRatchet({
      fact: makeFact('Juno considers Aster their closest friend'),
      interlocutorContactId: 'contact-stub',
      contactStore: stubStore as any,
      canonicalContactName: 'Juno',
      companionName: 'Aster',
    });

    expect(updateRelationshipType).toHaveBeenCalledWith(
      'contact-stub',
      'acquaintance',
      'system:memory_extraction:interlocutor',
    );
    expect(result).toBeUndefined();
  });
});

describe('MemoryExtractor interlocutor relationship ratchet', () => {
  let memoryStore: InMemoryMemoryStore;
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    memoryStore = new InMemoryMemoryStore();
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  function makeExtractor(): MemoryExtractor {
    return new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Aster' } as any,
      memoryStore.asPort(),
      {
        embed: vi.fn().mockResolvedValue(makeEmbedding()),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      } as any,
      { emit: vi.fn().mockResolvedValue(undefined) } as any,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
    );
  }

  it('ratchets the routed interlocutor through the live processFact path', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const extractor = makeExtractor();

    await (extractor as any).processFact(
      makeFact('Juno considers Aster their closest friend'),
      'discord:juno-dm:1',
      juno.id,
      undefined,
      'discord:juno-dm',
      undefined,
      juno.displayName,
      'Aster',
    );

    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('acquaintance');
  });

  it('does not ratchet the interlocutor from a third-party mention on the live path', async () => {
    const juno = await contactStore.upsert({
      displayName: 'Juno',
      relationshipType: 'stranger',
    });

    const extractor = makeExtractor();

    await (extractor as any).processFact(
      makeFact("Juno's friend Sam stopped by the studio"),
      'discord:juno-dm:2',
      juno.id,
      undefined,
      'discord:juno-dm',
      undefined,
      juno.displayName,
      'Aster',
    );

    expect((await contactStore.getById(juno.id))?.relationshipType).toBe('stranger');
  });
});
