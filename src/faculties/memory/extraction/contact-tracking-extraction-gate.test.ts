import { resolveCanonicalMemorySubjectContactId } from '../subject-evidence.js';
import { buildSpeakerRoutingContext, resolveFactRouting } from './speaker-routing.js';
import { buildExtractionFactRoutingTelemetry } from './write-execution.js';
import { fromAny } from '@total-typescript/shoehorn';
// ── E3.4 contact-tracking policy gate: extraction behavior ──
// AC2: memories from untracked speakers keep speaker-name provenance but
// create zero contact-keyed records; the mention-only contact path respects
// the gate, and extraction handles an untracked speaker gracefully (no
// crashes, no fake contacts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { MemoryExtractor } from '../extraction.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../embedding.js';
import type { ExtractedFact } from '../types.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';

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
  let memoryStore: InMemoryMemoryStore;
  let contactStore: ContactStorePort;

  beforeEach(async () => {
    memoryStore = new InMemoryMemoryStore();
    ({ store: contactStore } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  function makeExtractor(isAutoContactCreationAllowed?: (channelId: string) => boolean): MemoryExtractor {
    return new MemoryExtractor(
      fromAny({ complete: vi.fn() }),
      fromAny({ characterName: 'Companion' }),
      memoryStore.asPort(),
      fromAny({
        embed: vi.fn().mockResolvedValue(new Float32Array(EMBEDDING_DIMS)),
        embedBatch: vi.fn(),
        dims: EMBEDDING_DIMS,
      }),
      fromAny({ emit: vi.fn().mockResolvedValue(undefined) }),
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
      isAutoContactCreationAllowed ? { isAutoContactCreationAllowed } : undefined,
    );
  }

  it('skips mention-only contact creation in gated channels even with recurring evidence', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const gate = vi.fn((channelId: string) => channelId !== APPROVAL_CHANNEL);
    const extractor = makeExtractor(gate);

    for (const [index, text] of [
      "Avery's sister Alex is moving to Seattle",
      'Alex called before dinner with the family',
    ].entries()) {
      await (fromAny(extractor)).processFact(
        makeFact(text, { tags: ['family'] }),
        `${APPROVAL_CHANNEL}:${index}`,
        primary.id,
        undefined,
        APPROVAL_CHANNEL,
        undefined,
        primary.displayName,
        'Companion',
      );
    }

    // The same recurring evidence WOULD create a contact in an auto channel
    // (covered by mention-only-contacts.test.ts); here the gate blocks it.
    expect(gate).toHaveBeenCalledWith(APPROVAL_CHANNEL);
    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Alex')).toHaveLength(0);

    // Room-scoped facts are still written — the gate blocks contact rows, not memory.
    const channelMemories = memoryStore.getMemoriesByChannel(APPROVAL_CHANNEL, 10);
    expect(channelMemories.map(memory => memory.text)).toContain('Alex called before dinner with the family');
  });

  it('AC2: an untracked speaker fact keeps speaker-name provenance with zero contact-keyed rows', async () => {
    const extractor = makeExtractor(() => false);

    const result = await (fromAny(extractor)).processFact(
      makeFact('Vtubegooner69 said the room loves karaoke night', { type: 'episodic', tags: ['room'] }),
      `${APPROVAL_CHANNEL}:untracked`,
      undefined, // no canonical contact — the speaker is untracked
      undefined,
      APPROVAL_CHANNEL,
      undefined,
      undefined,
      'Companion',
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
    expect(await contactStore.listAll()).toHaveLength(0);

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

  it.each([
    { allowed: true, type: 'relational' as const }, { allowed: false, type: 'relational' as const },
    { allowed: true, type: 'semantic' as const }, { allowed: false, type: 'semantic' as const },
  ])('routes recurring named $type third-party facts with contact creation allowed=$allowed', async ({ allowed, type }) => {
    const primary = await contactStore.upsert({ displayName: 'Avery', discordUserId: PRIMARY_USER_ID });
    const extractor = makeExtractor(() => allowed);
    const channelId = 'discord:dm:family-example';
    const texts = type === 'semantic'
      ? ['Alex studies marine biology at university', 'Alex enjoys hiking in the mountains']
      : ["Avery's sister Alex is moving to Seattle", 'Alex called before dinner with the family'];
    for (const [index, text] of texts.entries()) {
      const id = index + 1;
      const extracted = makeFact(text, {
        type, tags: type === 'relational' ? ['family'] : [],
        attribution: { sourceMessageIds: [id], sourceSpeakerName: 'Avery', subjectName: 'Alex' },
      });
      const context = await buildSpeakerRoutingContext([{
        id, channelId, role: 'user', authorId: PRIMARY_USER_ID, authorName: 'Avery', content: text, timestamp: id * 1000,
      }], async () => primary.id, { contacts: await contactStore.listAll() });
      const route = resolveFactRouting(extracted, context, primary.id);
      expect(route.status).toBe('route');
      if (route.status !== 'route') throw new Error(route.reason);
      await (fromAny(extractor)).processFact(
        extracted, `${channelId}:${id}`, route.contactId, undefined, channelId, undefined,
        primary.displayName, 'Companion', undefined, undefined,
        buildExtractionFactRoutingTelemetry(route, primary.id),
      );
      if (index === 0) {
        expect((await contactStore.listAll()).find(contact => contact.displayName === 'Alex')).toBeUndefined();
        const first = memoryStore.getMemoriesByChannel(channelId, 10)[0]!;
        expect(first.provenance?.subjectName).toBe('Alex');
        expect(resolveCanonicalMemorySubjectContactId(first)).toBeUndefined();
      }
    }
    const subject = (await contactStore.listAll()).find(contact => contact.displayName === 'Alex');
    const memories = memoryStore.getMemoriesByChannel(channelId, 10);
    expect(memories).toHaveLength(2);
    if (allowed) {
      expect(subject).toBeDefined();
      expect(memories.find(memory => memory.text === texts[1])).toMatchObject({
        contactId: subject!.id, provenance: { subjectContactId: subject!.id, sourceContactId: primary.id },
      });
      expect(subject?.relationshipType).toBe('stranger');
      expect(memories.every(memory => resolveCanonicalMemorySubjectContactId(memory) === subject?.id)).toBe(true);
    } else {
      expect(subject).toBeUndefined();
      expect(memories.every(memory => memory.provenance?.subjectName === 'Alex')).toBe(true);
      expect(memories.every(memory => !memory.provenance?.subjectContactId)).toBe(true);
    }
  });

  it('does not expand group mention creation to semantic facts', async () => {
    const primary = await contactStore.upsert({ displayName: 'Avery', discordUserId: PRIMARY_USER_ID });
    const extractor = makeExtractor(() => true);
    for (const [index, text] of ['Alex studies marine biology', 'Alex enjoys mountain hiking'].entries()) {
      await (fromAny(extractor)).processFact(
        makeFact(text, { type: 'semantic' }), `group-example:${index}`, primary.id,
        undefined, 'discord-room', undefined, primary.displayName, 'Companion', undefined, undefined,
        { routingReason: 'structured_source_metadata', subjectName: 'Alex', sourceContactId: primary.id },
      );
    }
    expect((await contactStore.listAll()).find(contact => contact.displayName === 'Alex')).toBeUndefined();
  });

  it('leaves auto channels byte-identical: absent predicate keeps the mention-only path active', async () => {
    const primary = await contactStore.upsert({
      displayName: 'Avery',
      discordUserId: PRIMARY_USER_ID,
    });
    const extractor = makeExtractor();

    for (const [index, text] of [
      "Avery's sister Alex is moving to Seattle",
      'Alex called before dinner with the family',
    ].entries()) {
      await (fromAny(extractor)).processFact(
        makeFact(text, { tags: ['family'] }),
        `api:auto-room:${index}`,
        primary.id,
        undefined,
        'api:auto-room',
        undefined,
        primary.displayName,
        'Companion',
      );
    }

    expect((await contactStore.listAll()).filter(contact => contact.displayName === 'Alex')).toHaveLength(1);
  });
});
