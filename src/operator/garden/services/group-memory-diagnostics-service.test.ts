import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../../core/contacts/types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { MemoryStorePort, ContactProfileArtifact } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import { EventBus } from '../../../shared/event-bus.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  createEmptyWatermark,
  type GroupMemoryWatermarkStorePort,
} from '../../../faculties/memory/extraction/group-ranges.js';
import { AdminGroupMemoryDataService } from './group-memory-diagnostics-service.js';

const CHANNEL_ID = 'discord:room';

function makeSettings(): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    memoryMode: 'group',
    autoDetection: {
      ...defaults.autoDetection,
      recentParticipantWindowMessages: 50,
    },
    onlineExtraction: {
      ...defaults.onlineExtraction,
      observedMessageTriggerCount: 50,
      maxMessagesPerChunk: 50,
      maxBacklogChunksPerRun: 1,
    },
    telemetry: {
      ...defaults.telemetry,
      maxDiagnosticMemoryScan: 500,
    },
  };
}

function makeEntry(id: number, authorId: string, authorName: string, content: string): SessionEntry {
  return {
    id,
    channelId: CHANNEL_ID,
    role: 'user',
    content,
    authorId,
    authorName,
    timestamp: id * 1_000,
  };
}

function makeContact(id: string, displayName: string): Contact {
  return {
    id,
    displayName,
    trustLevel: 'regular',
    relationshipType: 'acquaintance',
    firstSeen: '2026-06-28T00:00:00.000Z',
    lastSeen: '2026-06-28T00:00:00.000Z',
  };
}

function makeMemory(id: string, overrides: Partial<PurrMemory>): PurrMemory {
  return {
    id,
    text: `memory ${id}`,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: `${CHANNEL_ID}:extract|source:session`,
    sourceType: 'turn',
    extractedAt: 1_000,
    lastAccessed: 1_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function makeSessionStore(entries: SessionEntry[]): SessionStore {
  return {
    listChannels: vi.fn(() => [{ sessionId: CHANNEL_ID, channelId: CHANNEL_ID, messageCount: entries.length }]),
    listSessionsByRecentActivity: vi.fn(() => [{
      sessionId: CHANNEL_ID,
      channelId: CHANNEL_ID,
      channelType: 'discord',
      lastActivityAt: 9_000,
      messageCount: entries.length,
      lastRole: 'user',
      lastMessagePreview: 'redacted',
    }]),
    getSessionActivity: vi.fn(() => ({
      sessionId: CHANNEL_ID,
      channelId: CHANNEL_ID,
      channelType: 'discord',
      lastActivityAt: 9_000,
      messageCount: entries.length,
      lastRole: 'user',
      lastMessagePreview: 'redacted',
    })),
    getRecent: vi.fn((_channelId: string, limit: number) => entries.slice(-limit)),
    getLastEntry: vi.fn(() => entries.at(-1)),
    getEntriesAfter: vi.fn((_channelId: string, afterId: number, limit: number) => (
      entries.filter(entry => entry.id > afterId).slice(0, limit)
    )),
    getEntriesInRange: vi.fn((_channelId: string, startId: number, endId: number) => (
      entries.filter(entry => entry.id >= startId && entry.id <= endId)
    )),
  } as unknown as SessionStore;
}

function makeContactStore(contacts: Contact[]): ContactStorePort {
  return {
    listAll: vi.fn(async () => contacts),
    getByChannelIdentity: vi.fn(async (_channel, channelUserId) => (
      contacts.find(contact => contact.id === `contact-${channelUserId}`)
    )),
  } as unknown as ContactStorePort;
}

function makeMemoryStore(
  memories: PurrMemory[],
  profiles: Record<string, ContactProfileArtifact | undefined>,
): MemoryStorePort {
  return {
    getAllActiveMemories: vi.fn(async () => memories),
    getContactProfile: vi.fn(async contactId => profiles[contactId]),
  } as unknown as MemoryStorePort;
}

function makeWatermarkStore(): GroupMemoryWatermarkStorePort {
  return {
    get: vi.fn(channelId => createEmptyWatermark(channelId)),
    markProcessed: vi.fn(),
    markSkipped: vi.fn(),
    markFailed: vi.fn(),
  } as unknown as GroupMemoryWatermarkStorePort;
}

describe('AdminGroupMemoryDataService', () => {
  it('exposes resolved group-memory diagnostics without raw transcript or memory text', async () => {
    const eventBus = new EventBus();
    const settings = makeSettings();
    const entries = [
      makeEntry(1, 'alice', 'Alice', 'Carlini, remember I prefer jasmine tea.'),
      makeEntry(2, 'bob', 'Bob', 'My brother Vega is helping with moderation.'),
      makeEntry(3, 'alice', 'Alice', 'lol'),
    ];
    const contacts = [
      makeContact('contact-alice', 'Alice'),
      makeContact('contact-bob', 'Bob'),
    ];
    const memories = [
      makeMemory('mem-alice', {
        contactId: 'contact-alice',
        provenance: {
          channelId: CHANNEL_ID,
          sourceContactId: 'contact-alice',
          subjectContactId: 'contact-alice',
          routedContactId: 'contact-alice',
        },
      }),
      makeMemory('mem-bob', {
        contactId: 'contact-bob',
        provenance: {
          channelId: CHANNEL_ID,
          sourceContactId: 'contact-bob',
          subjectContactId: 'contact-bob',
          routedContactId: 'contact-bob',
        },
      }),
    ];
    const service = new AdminGroupMemoryDataService({
      groupMemory: settings,
      sessionStore: makeSessionStore(entries),
      memoryStore: makeMemoryStore(memories, {
        'contact-alice': {
          contactId: 'contact-alice',
          summary: 'Alice has a concise profile.',
          sourceMemoryIds: ['mem-alice'],
          confidenceScore: 0.9,
          noveltyScore: 0.8,
          updatedAt: 2_000,
        },
      }),
      contactStore: makeContactStore(contacts),
      watermarkStore: makeWatermarkStore(),
      eventBus,
      companionNames: ['Carlini'],
    });

    await eventBus.emit('memory.extraction.end', {
      channelId: CHANNEL_ID,
      count: 1,
      triggerReason: 'observed_count',
      parsedCount: 3,
      acceptedCount: 1,
      rejectedCount: 2,
      writeCount: 1,
      deduplicatedCount: 0,
      supersededCount: 0,
      rejectionBreakdown: { low_signal: 2 },
      ambiguousSpeakerSkippedCount: 1,
      ambiguousSpeakerSkipReasons: { ambiguous_group_speaker: 1 },
      writeCapSkips: [{
        reason: 'contact_cap',
        skippedCount: 1,
        configuredLimit: 1,
        affectedContactIds: ['contact-alice'],
      }],
      compositionalMode: 'legacy',
      chunkCount: 1,
      mergedFactCount: 3,
      crossChunkDeduplicatedCount: 0,
      boundaryFactCount: 0,
    });

    const diagnostics = await service.getGroupMemoryChannelDiagnostics(CHANNEL_ID);

    expect(diagnostics).toEqual(expect.objectContaining({
      channelId: CHANNEL_ID,
      channelType: 'discord',
      messageCount: 3,
      privacy: {
        rawTranscriptTextIncluded: false,
        memoryTextIncluded: false,
      },
    }));
    expect(diagnostics?.classification).toEqual(expect.objectContaining({
      mode: 'group',
      reason: 'manual_group',
      recentParticipantCount: 2,
    }));
    expect(diagnostics?.resolvedConfig.onlineExtraction.maxMessagesPerChunk).toBe(50);
    expect(diagnostics?.resolvedConfig.telemetry.maxDiagnosticMemoryScan).toBe(500);
    expect(diagnostics?.range).toEqual(expect.objectContaining({
      watermarkLagMessageIds: 3,
      plannedChunkCount: 1,
    }));
    expect(diagnostics?.salience?.telemetry.messagesConsidered).toBe(3);
    expect(diagnostics?.salience?.candidateSpans[0]).toEqual(expect.objectContaining({
      sourceMessageIds: expect.arrayContaining([1]),
      reasons: expect.arrayContaining(['companion_mention']),
      contributingContactIds: expect.arrayContaining(['contact-alice']),
    }));
    expect(diagnostics?.lastExtraction).toEqual(expect.objectContaining({
      parsedCount: 3,
      acceptedCount: 1,
      ambiguousSpeakerSkipReasons: { ambiguous_group_speaker: 1 },
      writeCapSkips: [expect.objectContaining({ reason: 'contact_cap' })],
    }));
    expect(diagnostics?.coverage.perContact).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contactId: 'contact-alice',
        profileStatus: 'profile_ready',
        totalAttributedMemoryCount: 1,
      }),
      expect.objectContaining({
        contactId: 'contact-bob',
        profileStatus: 'insufficient_source_memories',
        totalAttributedMemoryCount: 1,
      }),
    ]));
    expect(JSON.stringify(diagnostics)).not.toContain('jasmine tea');
    expect(JSON.stringify(diagnostics)).not.toContain('memory mem-alice');
  });

  it('does not expose channel diagnostics when Garden diagnostics are disabled', async () => {
    const settings = makeSettings();
    settings.telemetry.exposeGardenDiagnostics = false;
    const service = new AdminGroupMemoryDataService({
      groupMemory: settings,
      sessionStore: makeSessionStore([
        makeEntry(1, 'alice', 'Alice', 'Carlini, remember I prefer jasmine tea.'),
      ]),
      memoryStore: makeMemoryStore([], {}),
      contactStore: makeContactStore([makeContact('contact-alice', 'Alice')]),
      watermarkStore: makeWatermarkStore(),
      companionNames: ['Carlini'],
    });

    await expect(service.getGroupMemoryChannelDiagnostics(CHANNEL_ID)).resolves.toBeNull();
    await expect(service.listGroupMemoryDiagnostics()).resolves.toEqual({
      channels: [],
      reasonCounts: {},
    });
  });
});
