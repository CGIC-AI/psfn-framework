import { describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataWithMessageAddressing } from '../../../core/session/message-addressing.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  createDefaultGroupMemorySettings,
  normalizeGroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { MemoryExtractor } from '../extraction.js';
import {
  createEmptyWatermark,
  type GroupMemoryFailureInput,
  type GroupMemoryWatermarkMutationInput,
  type GroupMemoryWatermarkStorePort,
} from './group-ranges.js';
import { ObservedGroupMemoryScheduler } from './group-observed-scheduler.js';

const CHANNEL_ID = 'discord:shared-attribution-room';
const MORGAN = { authorId: 'morgan-user', authorName: 'Morgan' } as const;
const TARGET = { authorId: 'cedar-bot', authorName: 'Cedar' } as const;
const COMPANIONS = ['Cedar', 'Juniper', 'Maple', 'Rowan', 'Willow'] as const;

function makeAddressedEntry(observerName: string): SessionEntry {
  const observerAuthorId = `${observerName.toLowerCase()}-bot`;
  return {
    id: 1,
    channelId: CHANNEL_ID,
    role: 'user',
    // CogSec may sanitize the body. The typed addressing envelope, not body
    // visibility or prose, is the authority for speaker and addressee.
    content: 'I call you love when the observatory is quiet. [sanitized]',
    authorId: MORGAN.authorId,
    authorName: MORGAN.authorName,
    timestamp: 1_000,
    channelVisibility: 'invite_only',
    discordMessageId: 'discord-message-1',
    metadata: buildSessionMetadataWithMessageAddressing(undefined, {
      schemaVersion: 2,
      source: 'discord',
      author: MORGAN,
      observer: { authorId: observerAuthorId, authorName: observerName },
      mentionedTargets: [TARGET],
      channel: { scope: 'group', channelId: CHANNEL_ID },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{ ...TARGET, evidence: ['mention'] }],
      },
    }),
  };
}

function makeModelResponse(observerName: string): string {
  const observerConfabulation = observerName === TARGET.authorName
    ? ''
    : `<fact>
<text>Morgan affectionately called ${observerName} love while speaking to Cedar.</text>
<type>relational</type>
<importance>0.96</importance>
<confidence>0.98</confidence>
<source_message_ids>1</source_message_ids>
<source_speaker_name>Morgan</source_speaker_name>
<subject_name>${observerName}</subject_name>
<address_mode>overheard_room_context</address_mode>
</fact>`;
  const trueAddressMode = observerName === TARGET.authorName
    ? 'direct_to_companion'
    : 'overheard_room_context';
  return `<response>
${observerConfabulation}
<fact>
<text>${observerName} affectionately called Cedar love.</text>
<type>relational</type>
<importance>0.96</importance>
<confidence>0.98</confidence>
<source_message_ids>1</source_message_ids>
<source_speaker_name>${observerName}</source_speaker_name>
<subject_name>Cedar</subject_name>
<address_mode>${trueAddressMode}</address_mode>
</fact>
<fact>
<text>Morgan affectionately called Cedar love.</text>
<type>relational</type>
<importance>0.96</importance>
<confidence>0.98</confidence>
<source_message_ids>1</source_message_ids>
<source_speaker_name>Morgan</source_speaker_name>
<subject_name>Cedar</subject_name>
<address_mode>${trueAddressMode}</address_mode>
</fact>
</response>`;
}

function makeWatermarkStore(): GroupMemoryWatermarkStorePort {
  let current = createEmptyWatermark(CHANNEL_ID);
  return {
    get: () => current,
    markProcessed: (input: GroupMemoryWatermarkMutationInput) => {
      current = {
        ...current,
        coveredUpToMessageId: input.endMessageId,
        updatedAt: input.recordedAt ?? 0,
        status: 'processed',
        processedSpanCount: current.processedSpanCount + 1,
      };
      return current;
    },
    markSkipped: (input: GroupMemoryWatermarkMutationInput & { reason: string }) => {
      current = {
        ...current,
        coveredUpToMessageId: input.endMessageId,
        updatedAt: input.recordedAt ?? 0,
        status: 'skipped',
        skippedSpanCount: current.skippedSpanCount + 1,
      };
      return current;
    },
    markFailed: (input: GroupMemoryFailureInput) => {
      current = {
        ...current,
        updatedAt: input.recordedAt ?? 0,
        status: 'failed',
        failureCount: current.failureCount + 1,
      };
      return current;
    },
  };
}

function makeObservedMessage(): SubstrateMessage {
  return {
    id: 'discord-message-1',
    channelId: CHANNEL_ID,
    channelType: 'discord',
    authorId: MORGAN.authorId,
    authorName: MORGAN.authorName,
    content: 'I call you love when the observatory is quiet. [sanitized]',
    timestamp: new Date(1_000),
    routing: { source: 'discord', responseMode: 'observe' },
  };
}

function makeGroupSettings() {
  const defaults = createDefaultGroupMemorySettings();
  return normalizeGroupMemorySettings({
    ...defaults,
    memoryMode: 'group',
    onlineExtraction: {
      ...defaults.onlineExtraction,
      observedMessageTriggerCount: 1,
      cooldownMs: 0,
    },
  });
}

async function runProductionExtraction(observerName: string) {
  const entry = makeAddressedEntry(observerName);
  const memoryStore = new InMemoryMemoryStore();
  const llmComplete = vi.fn().mockResolvedValue({
    content: makeModelResponse(observerName),
  });
  const morganContact = {
    id: 'contact-morgan',
    displayName: MORGAN.authorName,
    discordUserId: MORGAN.authorId,
    relationshipType: 'stranger',
  };
  const contactStore = {
    getByChannelIdentity: vi.fn(async (_channel: string, authorId: string) => (
      authorId === MORGAN.authorId ? morganContact : undefined
    )),
    getByDiscordUserId: vi.fn(async (authorId: string) => (
      authorId === MORGAN.authorId ? morganContact : undefined
    )),
    getById: vi.fn(async (contactId: string) => (
      contactId === morganContact.id ? morganContact : undefined
    )),
    listAll: vi.fn(async () => [morganContact]),
    upsert: vi.fn(),
    updateRelationshipType: vi.fn(async () => false),
    updateEmotionalBaseline: vi.fn(async () => undefined),
  };
  const extractor = new MemoryExtractor(
    { complete: llmComplete } as never,
    { characterName: observerName } as never,
    memoryStore.asPort(),
    {
      embed: vi.fn().mockResolvedValue(new Float32Array(8).fill(0.25)),
      embedBatch: vi.fn(),
      dims: 8,
    },
    { emit: vi.fn().mockResolvedValue(undefined) },
    { extractionInterval: 1 },
    null,
    null,
    contactStore as never,
    { isAutoContactCreationAllowed: () => false },
  );
  const reader = {
    getRecent: vi.fn(() => [entry]),
    getLastEntry: vi.fn(() => entry),
    getEntriesInRange: vi.fn(() => [entry]),
    getEntriesAfter: vi.fn(() => [entry]),
  };
  const scheduler = new ObservedGroupMemoryScheduler({
    groupMemory: makeGroupSettings(),
    sessionReader: reader,
    watermarkStore: makeWatermarkStore(),
    memoryExtractor: extractor,
    companionNames: [observerName],
    companionAuthorIds: [`${observerName.toLowerCase()}-bot`],
    nowMs: () => 2_000,
    estimateEntryTokens: () => 1,
  });

  const decision = await scheduler.observeMessage(makeObservedMessage());
  return { decision, llmComplete, memories: memoryStore.getAllActiveMemories() };
}

describe('production group attribution boundary (fwoso)', () => {
  it('never treats visibility as speaker or direct address across five observing companions', async () => {
    for (const observerName of COMPANIONS) {
      const { decision, llmComplete, memories } = await runProductionExtraction(observerName);

      expect(decision).toMatchObject({ status: 'scheduled' });
      expect(JSON.stringify(llmComplete.mock.calls)).toContain(
        '[resolved_addressee: Cedar (author_id=cedar-bot; evidence=mention)]',
      );
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({
        text: 'Morgan affectionately called Cedar love.',
        contactId: 'contact-morgan',
        provenance: {
          sourceSpeakerName: 'Morgan',
          sourceAuthorId: MORGAN.authorId,
          subjectName: 'Cedar',
          addressMode: observerName === TARGET.authorName
            ? 'direct_to_companion'
            : 'overheard_room_context',
        },
      });
      expect(memories.some(memory => memory.text.includes(`${observerName} affectionately called Cedar`)))
        .toBe(false);
      if (observerName !== TARGET.authorName) {
        expect(memories.some(memory => memory.text.includes(`called ${observerName} love`)))
          .toBe(false);
        expect(memories.some(memory => memory.provenance?.addressMode === 'direct_to_companion'))
          .toBe(false);
      }
    }
  });
});
