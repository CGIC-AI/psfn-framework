import { fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { buildSessionMetadataWithSpeakerAttribution } from '../../../core/session/speaker-attribution.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { MemoryExtractor } from '../extraction.js';
import { classifyMemorySubject } from '../subject-classification.js';

const alex: Contact = {
  id: 'contact-alex', displayName: 'Alex', nickname: 'Lex', trustLevel: 'trusted',
  relationshipType: 'friend', firstSeen: '', lastSeen: '',
};
const robin: Contact = { ...alex, id: 'contact-robin', displayName: 'Robin', nickname: undefined, isMachineIntelligence: true };
const channelId = '123456789012345678';

async function extract(text: string, subject: string, source: string | undefined, ids: number[], contacts = [alex, robin]) {
  const entries: SessionEntry[] = [
    { id: 1, channelId, role: 'user', authorId: 'transport-alex', authorName: 'Alex',
      content: 'Robin studies marine biology at the local university. We went sailing last summer.', timestamp: 1000,
      metadata: buildSessionMetadataWithSpeakerAttribution(undefined, alex.id) },
    { id: 2, channelId, role: 'assistant', content: 'I promised to join the sailing club this summer.', timestamp: 2000 },
  ];
  const llm = { complete: vi.fn().mockResolvedValue({ content: `<response><fact>
<text>${text}</text><type>semantic</type><importance>0.9</importance><confidence>0.95</confidence>
<source_message_ids>${ids.join(',')}</source_message_ids>${source ? `<source_speaker_name>${source}</source_speaker_name>` : ''}
<subject_name>${subject}</subject_name></fact></response>` }) };
  const memoryStore = new InMemoryMemoryStore();
  const contactStore = fromPartial<ContactStorePort>({
    listAll: vi.fn(async () => contacts), getById: vi.fn(async id => contacts.find(contact => contact.id === id)),
    getByChannelIdentity: vi.fn(async () => undefined), getByDiscordUserId: vi.fn(async () => undefined),
    updateEmotionalBaseline: vi.fn(), upsert: vi.fn(),
  });
  const extractor = new MemoryExtractor(
    fromPartial(llm),
    fromPartial({ characterName: 'Lyra', getRecentMessages: () => entries, getMessageCount: () => entries.length,
      resolveSessionChannelId: () => channelId, intakeSinkGate: null }),
    memoryStore.asPort(),
    { embed: vi.fn(async () => new Float32Array(8).fill(0.25)), embedBatch: vi.fn(), dims: 8 },
    { emit: vi.fn() }, { extractionInterval: 1 }, null, null, contactStore,
    { isAutoContactCreationAllowed: () => false },
  );
  await extractor.extract(channelId, alex.id);
  return { memories: memoryStore.getAllActiveMemories(), llm, contactStore };
}

describe('direct extraction through the production writer', () => {
  it('writes a structured alias-attributed DM fact with a retrievable contact subject', async () => {
    const { memories } = await extract('Lex went sailing last summer.', 'Lex', 'Lex', [1]);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ contactId: alex.id,
      provenance: { subjectContactId: alex.id, sourceContactId: alex.id } });
    expect(classifyMemorySubject(memories[0]!, { memoryRevision: 1 })).toMatchObject({
      subjectClass: 'single_contact', subjectContactIds: [alex.id],
    });
  });

  it('persists mixed user/assistant evidence without a model-supplied source name', async () => {
    const { memories } = await extract('Alex went sailing last summer.', 'Alex', undefined, [1, 2]);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ contactId: alex.id, provenance: {
      subjectContactId: alex.id, sourceContactId: alex.id, sourceMessageIds: [1, 2],
    } });
  });

  it('links a known sibling subject without requiring them to speak or creating a new contact', async () => {
    const { memories, contactStore } = await extract('Robin studies marine biology.', 'Robin', 'Lex', [1]);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ contactId: robin.id,
      provenance: { subjectContactId: robin.id, sourceContactId: alex.id } });
    expect(contactStore.upsert).not.toHaveBeenCalled();
  });

  it('writes companion self-knowledge with companion ownership and turn provenance', async () => {
    const { memories, llm } = await extract('Lyra promised to join the sailing club.', 'Lyra', 'Lyra', [2]);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ provenance: {
      actor: 'companion', subjectScope: 'companion_internal', subjectName: 'Lyra', sourceMessageIds: [2],
    } });
    expect(memories[0]?.contactId).toBeUndefined();
    expect(classifyMemorySubject(memories[0]!, { memoryRevision: 1 }).subjectClass).toBe('companion_private');
    expect(JSON.stringify(llm.complete.mock.calls)).toContain('Preserve named third-party facts');
  });
});
