// ── E3.4 contact-tracking policy gate: extraction behavior ──
// AC2: memories from untracked speakers keep speaker-name provenance but
// create zero contact-keyed records; the mention-only contact path respects
// the gate, and extraction handles an untracked speaker gracefully (no
// crashes, no fake contacts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ContactStore } from '../../../core/contacts/store.js';
import { MemoryExtractor } from '../extraction.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../embedding.js';
import { MemoryStore } from '../store.js';
import type { ExtractedFact } from '../types.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;
const PRIMARY_USER_ID = 'discord-primary-user';
const APPROVAL_CHANNEL = 'discord:big-room';

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

describe('MemoryExtractor contact-tracking gate (E3.4)', () => {
  let db: Database.Database;
  let memoryStore: MemoryStore;
  let contactStore: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    memoryStore = new MemoryStore(db);
    contactStore = new ContactStore(db, PRIMARY_USER_ID);
  });

  function makeExtractor(isAutoContactCreationAllowed?: (channelId: string) => boolean): MemoryExtractor {
    return new MemoryExtractor(
      { complete: vi.fn() } as any,
      { characterName: 'Purrsephone' } as any,
      memoryStore,
      {
        embed: vi.fn().mockResolvedValue(new Float32Array(EMBEDDING_DIMS)),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      } as any,
      { emit: vi.fn().mockResolvedValue(undefined) } as any,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
      isAutoContactCreationAllowed ? { isAutoContactCreationAllowed } : undefined,
    );
  }

  it('skips mention-only contact creation in gated channels even with recurring evidence', async () => {
    const primary = contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const gate = vi.fn((channelId: string) => channelId !== APPROVAL_CHANNEL);
    const extractor = makeExtractor(gate);

    for (const [index, text] of [
      "Avery's sister Alex is moving to Seattle",
      'Alex called before dinner with the family',
    ].entries()) {
      await (extractor as any).processFact(
        makeFact(text, { tags: ['family'] }),
        `${APPROVAL_CHANNEL}:${index}`,
        primary.id,
        undefined,
        APPROVAL_CHANNEL,
        undefined,
        primary.displayName,
        'Purrsephone',
      );
    }

    // The same recurring evidence WOULD create a contact in an auto channel
    // (covered by mention-only-contacts.test.ts); here the gate blocks it.
    expect(gate).toHaveBeenCalledWith(APPROVAL_CHANNEL);
    expect(contactStore.listAll().filter(contact => contact.displayName === 'Alex')).toHaveLength(0);

    // Room-scoped facts are still written — the gate blocks contact rows, not memory.
    const channelMemories = memoryStore.getMemoriesByChannel(APPROVAL_CHANNEL, 10);
    expect(channelMemories.map(memory => memory.text)).toContain('Alex called before dinner with the family');
  });

  it('AC2: an untracked speaker fact keeps speaker-name provenance with zero contact-keyed rows', async () => {
    const extractor = makeExtractor(() => false);

    const result = await (extractor as any).processFact(
      makeFact('Vtubegooner69 said the room loves karaoke night', { type: 'episodic', tags: ['room'] }),
      `${APPROVAL_CHANNEL}:untracked`,
      undefined, // no canonical contact — the speaker is untracked
      undefined,
      APPROVAL_CHANNEL,
      undefined,
      undefined,
      'Purrsephone',
      undefined,
      undefined,
      {
        sourceSpeakerName: 'vtubegooner69',
        sourceAuthorId: 'stranger-42',
        routingReason: 'speaker_name_prefix',
      },
    );

    // No crash, no fake contact, no contact-keyed row.
    expect(result.action).not.toBe('skipped');
    expect(contactStore.listAll()).toHaveLength(0);

    const [memory] = memoryStore.getMemoriesByChannel(APPROVAL_CHANNEL, 10);
    expect(memory).toBeDefined();
    // Attribution truth retained…
    expect(memory.provenance?.sourceSpeakerName).toBe('vtubegooner69');
    expect(memory.provenance?.sourceAuthorId).toBe('stranger-42');
    // …but zero contact-keyed columns (contactId FK, source/subject contact ids).
    expect(memory.contactId ?? null).toBeNull();
    expect(memory.provenance?.sourceContactId).toBeUndefined();
    expect(memory.provenance?.subjectContactId).toBeUndefined();
  });

  it('leaves auto channels byte-identical: absent predicate keeps the mention-only path active', async () => {
    const primary = contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const extractor = makeExtractor();

    for (const [index, text] of [
      "Avery's sister Alex is moving to Seattle",
      'Alex called before dinner with the family',
    ].entries()) {
      await (extractor as any).processFact(
        makeFact(text, { tags: ['family'] }),
        `api:auto-room:${index}`,
        primary.id,
        undefined,
        'api:auto-room',
        undefined,
        primary.displayName,
        'Purrsephone',
      );
    }

    expect(contactStore.listAll().filter(contact => contact.displayName === 'Alex')).toHaveLength(1);
  });
});
