import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ContactStore } from '../../../core/contacts/store.js';
import { MemoryExtractor } from '../extraction.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../embedding.js';
import { MemoryStore } from '../store.js';
import type { ExtractedFact } from '../types.js';
import {
  extractMentionOnlyContactCandidate,
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
      companionName: 'Purrsephone',
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
      companionName: 'Purrsephone',
    });

    expect(candidate?.name).toBe('Alex');
    expect(candidate?.relationshipType).toBe('friend');
  });

  it('excludes canonical user and companion names from fallback matching', () => {
    expect(extractMentionOnlyContactCandidate({
      fact: makeFact('Purrsephone is Avery\'s companion'),
      canonicalContactName: 'Avery',
      companionName: 'Purrsephone',
    })).toBeUndefined();

    expect(extractMentionOnlyContactCandidate({
      fact: makeFact('Avery helped their family with dinner', { tags: ['family'] }),
      canonicalContactName: 'Avery',
      companionName: 'Purrsephone',
    })).toBeUndefined();
  });
});

describe('resolveMentionOnlyContactForFact', () => {
  let db: Database.Database;
  let memoryStore: MemoryStore;
  let contactStore: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    memoryStore = new MemoryStore(db);
    contactStore = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('promotes an existing contact relationship from stronger recurring evidence', async () => {
    const primary = contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const alex = contactStore.upsert({
      displayName: 'Alex',
      relationshipType: 'stranger',
    });

    const resolved = await resolveMentionOnlyContactForFact({
      fact: makeFact("Avery's sister Alex is visiting this weekend", { tags: ['family'] }),
      channelId: 'api:mention-contact',
      canonicalContactId: primary.id,
      canonicalContactName: primary.displayName,
      companionName: 'Purrsephone',
      contactStore,
      memoryStore,
    });

    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(alex.id);
    expect(contactStore.getById(alex.id)?.relationshipType).toBe('family');
  });
});

describe('MemoryExtractor mention-only contacts', () => {
  let db: Database.Database;
  let memoryStore: MemoryStore;
  let contactStore: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    memoryStore = new MemoryStore(db);
    contactStore = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('creates and relinks a mention-only contact only after recurring evidence', async () => {
    const primary = contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });

    const extractor = new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Purrsephone' } as any,
      memoryStore,
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
	      'Purrsephone',
	    );

    expect(contactStore.listAll().filter(contact => contact.displayName === 'Alex')).toHaveLength(0);
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
	      'Purrsephone',
	    );

    const alexContacts = contactStore.listAll().filter(contact => contact.displayName === 'Alex');
    expect(alexContacts).toHaveLength(1);

    const alex = alexContacts[0];
    expect(alex.relationshipType).toBe('family');
    expect(secondWrite.action).not.toBe('skipped');

    const alexMemories = memoryStore.getMemoriesByContact(alex.id, 10);
    expect(alexMemories.map(memory => memory.text)).toContain("Avery's sister Alex is moving to Seattle");
    expect(memoryStore.getMemoriesByContact(primary.id, 10)).toHaveLength(0);
  });

  it('does not create a contact from a one-off relational mention', async () => {
    const primary = contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });

    const extractor = new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Purrsephone' } as any,
      memoryStore,
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
	      'Purrsephone',
	    );

    expect(contactStore.listAll().filter(contact => contact.displayName === 'Jordan')).toHaveLength(0);
    expect(memoryStore.getMemoriesByContact(primary.id, 10)).toHaveLength(1);
  });
});

describe('MemoryExtractor group-room speaker ownership', () => {
  let db: Database.Database;
  let memoryStore: MemoryStore;
  let contactStore: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    memoryStore = new MemoryStore(db);
    contactStore = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('writes clear mixed-speaker facts under the source speaker contact', async () => {
    const mrDragonFox = contactStore.upsert({
      displayName: 'MrDragonFox',
      discordUserId: 'discord-mrdragonfox',
    });
    const vega = contactStore.upsert({
      displayName: 'Vega',
      discordUserId: 'discord-vega',
    });
    const entries = [
      {
        id: 1,
        channelId: 'discord:kube',
        role: 'user',
        authorId: 'discord-mrdragonfox',
        authorName: 'MrDragonFox',
        content: 'ya i mean if we put her on twitch or yt live or ticktok we need also guardrails',
        timestamp: 1,
      },
      {
        id: 2,
        channelId: 'discord:kube',
        role: 'user',
        authorId: 'discord-vega',
        authorName: 'Vega',
        content: 'I can collect the notes after we finish this pass.',
        timestamp: 2,
      },
    ];
    const extractor = new MemoryExtractor(
      {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>MrDragonFox believes that if Carlini is put on Twitch, YouTube, or TikTok live, guardrails are needed.</text>
<type>semantic</type>
<importance>0.92</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
        }),
      } as any,
      {
        characterName: 'Carlini',
        getRecentMessages: vi.fn().mockReturnValue(entries),
      } as any,
      memoryStore,
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

    await extractor.extract('discord:kube', vega.id);

    expect(memoryStore.getMemoriesByContact(mrDragonFox.id, 10).map(memory => memory.text)).toContain(
      'MrDragonFox believes that if Carlini is put on Twitch, YouTube, or TikTok live, guardrails are needed.',
    );
    expect(memoryStore.getMemoriesByContact(vega.id, 10)).toHaveLength(0);
  });
});
