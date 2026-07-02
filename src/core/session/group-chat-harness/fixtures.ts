/**
 * Synthetic fixtures for the group-chat prompt-shape regression harness.
 *
 * Everything here is ANONYMIZED and SYNTHETIC: no live companion-data content
 * is committed. The fixtures are *shaped* like live usage so that prompt-shape
 * regressions are provable:
 *   - one group room (`room:townsquare`) with >= 3 humans plus one peer
 *     companion (a contact with `isMachineIntelligence: true`);
 *   - the same humans in individual DMs (`dm:<name>`);
 *   - a second room (`room:backchannel`) for room -> room leak probes;
 *   - one human (Dana) who is NOT a member of `room:townsquare`, used as the
 *     non-member DM leak probe target.
 *
 * The builders drive the REAL assembly path (SessionManager.buildContext with
 * a real scoped CoreMemoryStore, substrate-agent runtime-context rendering,
 * MemoryRetriever.retrieve with the real room-visibility gate) rather than
 * mocking prompt output.
 */
import { join } from 'node:path';
import type { EmbeddingProviderPort } from '../../agent/contracts.js';
import {
  buildDynamicPromptTemplateVariables,
  buildPromptTemplateVariables,
  resolveAuthorContext,
  type ResolvedAuthorContext,
} from '../../agent/substrate-agent/runtime-context.js';
import { renderFinalPromptSection } from '../../identity/prompt-runtime.js';
import { getDefaultRuntimePromptSections } from '../../identity/runtime-prompt-layers.js';
import { resolveConversationScopeFromMetadata } from '../conversation-scope.js';
import {
  classifyGroupMemoryChannel,
  type GroupMemoryClassification,
} from '../../../faculties/memory/extraction/group-classifier.js';
import { createDefaultGroupMemorySettings } from '../../../system/config/group-memory-config.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { Contact } from '../../contacts/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { CoreMemoryStore, coreMemoryChannelScope } from '../../../faculties/core-memory/store.js';
import type { MemoryStore } from '../../../faculties/memory/store.js';
import type { MemoryScopeRef, PurrMemory } from '../../../faculties/memory/types.js';
import type { ConsentFlags } from '../../../system/trust/types.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { SessionManager } from '../manager.js';
import type { SessionEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Scenario identifiers
// ---------------------------------------------------------------------------

export const GROUP_ROOM_ID = 'room:townsquare';
export const OTHER_ROOM_ID = 'room:backchannel';

export interface HarnessParticipant {
  id: string;
  name: string;
  /** Channel-level author id used when recording session messages. */
  authorId: string;
  trustLevel: Contact['trustLevel'];
  isMachineIntelligence: boolean;
}

/** Three humans plus one peer companion who all share the group room. */
export const ALICE: HarnessParticipant = {
  id: 'contact-alice',
  name: 'Alice',
  authorId: 'user-alice',
  trustLevel: 'trusted',
  isMachineIntelligence: false,
};
export const BOB: HarnessParticipant = {
  id: 'contact-bob',
  name: 'Bob',
  authorId: 'user-bob',
  trustLevel: 'regular',
  isMachineIntelligence: false,
};
export const CAROL: HarnessParticipant = {
  id: 'contact-carol',
  name: 'Carol',
  authorId: 'user-carol',
  trustLevel: 'trusted',
  isMachineIntelligence: false,
};
/** Peer companion: a different machine intelligence participating in the room. */
export const NOVA: HarnessParticipant = {
  id: 'contact-nova',
  name: 'Nova',
  authorId: 'peer-nova',
  trustLevel: 'regular',
  isMachineIntelligence: true,
};
/** Dana is NOT a member of the group room; used for the non-member DM probe. */
export const DANA: HarnessParticipant = {
  id: 'contact-dana',
  name: 'Dana',
  authorId: 'user-dana',
  trustLevel: 'trusted',
  isMachineIntelligence: false,
};

export const ROOM_MEMBERS: readonly HarnessParticipant[] = [ALICE, BOB, CAROL, NOVA];

export function dmChannelId(participant: HarnessParticipant): string {
  return `dm:${participant.name.toLowerCase()}`;
}

/**
 * Stable attribution id as rendered in group history: the channel source
 * prefix is prepended to the author id (see entry-attribution.ts
 * formatStableAuthorId / inferAuthorSourceFromChannelId).
 */
export function stableAttributionId(channelId: string, authorId: string): string {
  const separatorIndex = channelId.indexOf(':');
  const source = separatorIndex > 0 ? channelId.slice(0, separatorIndex) : undefined;
  if (!source || authorId.startsWith(`${source}:`)) return authorId;
  return `${source}:${authorId}`;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function makeContact(participant: HarnessParticipant, memberOfGroupRoom: boolean): Contact {
  return {
    id: participant.id,
    displayName: participant.name,
    trustLevel: participant.trustLevel,
    relationshipType: participant.isMachineIntelligence ? 'ai_companion' : 'friend',
    ...(participant.isMachineIntelligence ? { isMachineIntelligence: true } : {}),
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    channelIdentities: [{ channel: 'api', userId: participant.authorId }],
    conversationChannels: [
      {
        channel: 'api',
        channelId: dmChannelId(participant),
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-07-01T00:00:00.000Z',
        privacyLevel: 'private',
      },
      ...(memberOfGroupRoom
        ? [{
          channel: 'api' as const,
          channelId: GROUP_ROOM_ID,
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-07-01T00:00:00.000Z',
        }]
        : []),
    ],
  };
}

/** All synthetic contacts: 3 humans + peer companion + non-member human. */
export function makeGroupChatContacts(): Map<string, Contact> {
  const contacts = new Map<string, Contact>();
  for (const member of ROOM_MEMBERS) {
    contacts.set(member.id, makeContact(member, true));
  }
  contacts.set(DANA.id, makeContact(DANA, false));
  return contacts;
}

/**
 * Minimal contact-store double for MemoryRetriever room-visibility resolution
 * and social-context lookups. Only synthetic contacts, no live data.
 */
export function makeLeakProbeContactStore(): {
  getById: (id: string) => Promise<Contact | undefined>;
  getEmotionalSnapshot: (id: string) => Promise<undefined>;
  getSocialGraphEntityByContactId: (id: string) => Promise<undefined>;
  getSocialGraphEntityById: (id: string) => Promise<undefined>;
  listSocialRelationshipEdges: (query: unknown) => Promise<never[]>;
} {
  const contacts = makeGroupChatContacts();
  return {
    getById: async (id: string) => contacts.get(id),
    getEmotionalSnapshot: async () => undefined,
    getSocialGraphEntityByContactId: async () => undefined,
    getSocialGraphEntityById: async () => undefined,
    listSocialRelationshipEdges: async () => [],
  };
}

// ---------------------------------------------------------------------------
// SessionManager config + fixture session state
// ---------------------------------------------------------------------------

export function makeGroupChatConfig(dataDir: string, overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 64,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2_000 },
    },
    ...overrides,
  } as SubstrateConfig;
}

export interface GroupChatSessionFixture {
  manager: SessionManager;
  store: SessionStore;
  coreMemory: CoreMemoryStore;
  characterName: string;
}

const GROUP_HUMAN_BLOCK = 'Shared room profile: the group is coordinating an offsite; keep individual confidences out of the room.';
const ALICE_DM_HUMAN_BLOCK = 'Alice: prefers concise updates; trusts the companion with private career matters.';

/**
 * Build a SessionManager backed by a REAL scoped CoreMemoryStore, populated
 * with a multi-human group-room conversation plus per-human DMs through the
 * real recording API.
 */
export function buildGroupChatSession(dir: string): GroupChatSessionFixture {
  const store = new SessionStore(join(dir, 'sessions'));
  const manager = new SessionManager(store, makeGroupChatConfig(dir));
  const characterName = 'Companion';
  manager.characterName = characterName;

  const coreMemory = new CoreMemoryStore(join(dir, 'core-memory.json'));
  coreMemory.replace('human', GROUP_HUMAN_BLOCK, {
    scope: coreMemoryChannelScope({ channelId: GROUP_ROOM_ID, isDirectMessage: false }),
  });
  coreMemory.replace('human', ALICE_DM_HUMAN_BLOCK, {
    scope: coreMemoryChannelScope({ channelId: dmChannelId(ALICE), isDirectMessage: true }),
  });
  manager.setCoreMemoryProvider(coreMemory);

  // --- Group room: 3 humans + peer companion, interleaved turns ---
  manager.recordUserMessage(GROUP_ROOM_ID, 'Morning everyone, shall we plan the offsite?', ALICE.authorId, ALICE.name, false);
  manager.recordUserMessage(GROUP_ROOM_ID, 'I can book the venue if someone picks the date.', BOB.authorId, BOB.name, false);
  manager.recordUserMessage(GROUP_ROOM_ID, 'Nova, can you draft an agenda?', CAROL.authorId, CAROL.name, false);
  manager.recordUserMessage(GROUP_ROOM_ID, 'On it, I will circulate a draft agenda shortly.', NOVA.authorId, NOVA.name, false);
  manager.recordAssistantMessage(GROUP_ROOM_ID, 'Happy to help coordinate the offsite plan.');
  manager.recordUserMessage(GROUP_ROOM_ID, 'Great, let us aim for the last Friday of the month.', CAROL.authorId, CAROL.name, false);

  // --- Individual DMs with the same humans ---
  manager.recordUserMessage(dmChannelId(ALICE), 'Quietly: can we revisit my raise conversation?', ALICE.authorId, ALICE.name, true);
  manager.recordAssistantMessage(dmChannelId(ALICE), 'Of course, this stays between us.');
  manager.recordUserMessage(dmChannelId(BOB), 'Between us, I am nervous about the demo.', BOB.authorId, BOB.name, true);

  return { manager, store, coreMemory, characterName };
}

/**
 * Simulate a cold restart: a brand-new SessionManager + CoreMemoryStore over
 * the same on-disk companion-data as a prior `buildGroupChatSession(dir)`, with
 * NO async memory (sleeptime/orient) having run. Used to prove that startup
 * core-memory hydration surfaces the persisted scoped blocks on the first
 * post-restart prompt.
 */
export function restartGroupChatSession(dir: string): GroupChatSessionFixture {
  const store = new SessionStore(join(dir, 'sessions'));
  const manager = new SessionManager(store, makeGroupChatConfig(dir));
  const characterName = 'Companion';
  manager.characterName = characterName;
  const coreMemory = new CoreMemoryStore(join(dir, 'core-memory.json'));
  manager.setCoreMemoryProvider(coreMemory);
  return { manager, store, coreMemory, characterName };
}

/**
 * A DM session whose recent window starts with a stray user-role entry from a
 * DIFFERENT author (a relayed guest line) before the canonical partner speaks.
 * This is the trigger for the "core memory participant binds to
 * recentParticipants[0] instead of the canonical contact" defect
 * (SessionManager.buildCoreMemoryFormatContext).
 */
export function buildDmWithGuestSession(dir: string): GroupChatSessionFixture {
  const store = new SessionStore(join(dir, 'sessions'));
  const manager = new SessionManager(store, makeGroupChatConfig(dir));
  manager.characterName = 'Companion';

  const coreMemory = new CoreMemoryStore(join(dir, 'core-memory.json'));
  coreMemory.replace('human', ALICE_DM_HUMAN_BLOCK, {
    scope: coreMemoryChannelScope({ channelId: dmChannelId(ALICE), isDirectMessage: true }),
  });
  manager.setCoreMemoryProvider(coreMemory);

  // Guest line lands first in the recent window (e.g. relayed speech).
  manager.recordUserMessage(dmChannelId(ALICE), 'Relaying for Bob: he says the deck is ready.', BOB.authorId, BOB.name, true);
  manager.recordUserMessage(dmChannelId(ALICE), 'Thanks. Now, about my raise conversation.', ALICE.authorId, ALICE.name, true);
  manager.recordAssistantMessage(dmChannelId(ALICE), 'Of course, this stays between us.');

  return { manager, store, coreMemory, characterName: 'Companion' };
}

// ---------------------------------------------------------------------------
// Runtime prompt rendering (speaking_with / conversation_state)
// ---------------------------------------------------------------------------

/** Injected fixture clock shared by every harness render (determinism anchor). */
export const FIXTURE_NOW = new Date('2026-07-01T12:00:00Z');

// ---------------------------------------------------------------------------
// Internal (self-directed) turn fixtures: heartbeat and reflection channels.
// These mirror the scheduler-driven turn shape (resolveAuthorContext binds the
// companion as the subject with trust 'primary'; reflection turns may carry a
// canonical-contact routing hint for DM-scoped reflection).
// ---------------------------------------------------------------------------

export const HEARTBEAT_CHANNEL_ID = 'internal:heartbeat';
/** Reflection channel id shaped like heartbeat-template-runtime: internal:reflection:<templateId>. */
export const REFLECTION_CHANNEL_ID = 'internal:reflection:evening-reflection';

/** The companion itself, as the subject of self-directed internal turns. */
export const COMPANION_SELF: HarnessParticipant = {
  id: 'companion-self',
  name: 'Companion',
  authorId: 'companion-self',
  trustLevel: 'primary',
  isMachineIntelligence: false,
};

/** Build a SubstrateMessage for a self-directed internal turn (heartbeat/reflection). */
export function makeInternalTurnMessage(
  channelId: string,
  options: { routing?: SubstrateMessage['routing']; content?: string } = {},
): SubstrateMessage {
  return {
    id: 'msg-group-harness-internal',
    channelId,
    channelType: 'terminal',
    authorId: COMPANION_SELF.authorId,
    authorName: COMPANION_SELF.name,
    content: options.content ?? 'Internal turn prompt seed.',
    timestamp: FIXTURE_NOW,
    ...(options.routing ? { routing: options.routing } : {}),
  };
}

function makeMessage(overrides: Partial<SubstrateMessage>): SubstrateMessage {
  return {
    id: 'msg-group-harness',
    channelId: GROUP_ROOM_ID,
    channelType: 'api',
    authorId: CAROL.authorId,
    authorName: CAROL.name,
    content: 'Great, let us aim for the last Friday of the month.',
    timestamp: FIXTURE_NOW,
    ...overrides,
  };
}

/** Build a SubstrateMessage for a group-room turn authored by `speaker`. */
export function makeGroupTurnMessage(speaker: HarnessParticipant): SubstrateMessage {
  return makeMessage({
    channelId: GROUP_ROOM_ID,
    channelType: 'api',
    isDirectMessage: false,
    authorId: speaker.authorId,
    authorName: speaker.name,
  });
}

/** Build a SubstrateMessage for a one-on-one DM turn authored by `speaker`. */
export function makeDmTurnMessage(speaker: HarnessParticipant): SubstrateMessage {
  return makeMessage({
    channelId: dmChannelId(speaker),
    channelType: 'api',
    isDirectMessage: true,
    authorId: speaker.authorId,
    authorName: speaker.name,
    routing: { channelPrivacy: 'private' } as SubstrateMessage['routing'],
  });
}

/** Session entries shaped like the group room, for conversation_state rendering. */
export function makeGroupRoomRecentEntries(): SessionEntry[] {
  const turns: Array<{ speaker: HarnessParticipant; content: string }> = [
    { speaker: ALICE, content: 'Morning everyone, shall we plan the offsite?' },
    { speaker: BOB, content: 'I can book the venue if someone picks the date.' },
    { speaker: NOVA, content: 'On it, I will circulate a draft agenda shortly.' },
    { speaker: CAROL, content: 'Great, let us aim for the last Friday of the month.' },
  ];
  return turns.map((turn, index) => ({
    id: index + 1,
    channelId: GROUP_ROOM_ID,
    role: 'user' as const,
    content: turn.content,
    authorId: turn.speaker.authorId,
    authorName: turn.speaker.name,
    timestamp: FIXTURE_NOW.getTime() - (turns.length - index) * 60_000,
  }));
}

const BASE_DYNAMIC_INPUT = {
  responseStyle: 'concise' as const,
  now: FIXTURE_NOW,
  modelId: 'test-model',
  capabilityTier: 'autonomous' as const,
  activeToolCounts: { core: 0, promoted: 0, extendedLoaded: 0, autoload: 0, deferred: 0, total: 0 },
  extendedTools: [] as never[],
  loadedExtended: new Map(),
  classifyExtendedToolForTurn: () => 'overlay' as const,
  promotedExtendedToolNames: new Set<string>(),
  skillsContext: '',
  behavioralNotesBlock: '',
  config: {},
};

/** Compute the one-on-one identity template variables for a turn. */
export function buildTurnTemplateVariables(
  message: SubstrateMessage,
  speaker: HarnessParticipant,
  channelType: string,
  options: { now?: Date } = {},
): Record<string, string> {
  const { templateVariables } = buildPromptTemplateVariables({
    message,
    resolvedUserName: speaker.name,
    trustLevel: speaker.trustLevel,
    channelType,
    canonicalContactKey: speaker.id,
    subjectIdentityKey: undefined,
    now: options.now ?? FIXTURE_NOW,
    characterPromptVariables: { char_name: 'Companion' },
    modelId: 'test-model',
    fallbackCharacterName: 'Companion',
  });
  return templateVariables;
}

/**
 * Render the runtime-owned prompt layers for a turn through the real
 * runtime-context builders (contains speaking_with and conversation_state).
 */
export function renderTurnRuntimePrompt(
  message: SubstrateMessage,
  speaker: HarnessParticipant,
  channelType: string,
  options: {
    recentChannelEntries?: readonly SessionEntry[];
    /** Internal task kind for heartbeat/reflection turns (mirrors resolveTaskKind). */
    taskKind?: string;
  } = {},
): { prompt: string; variables: Record<string, string> } {
  const templateVariables = buildTurnTemplateVariables(message, speaker, channelType);
  // Mirror runtime ingress: the ConversationScope is resolved once from the
  // turn message's metadata (canonical contact binding on DM turns) and
  // threaded into the dynamic prompt variable build.
  const turnConversationScope = resolveConversationScopeFromMetadata({
    channelId: message.channelId,
    isDirectMessage: message.isDirectMessage,
    ...(message.isDirectMessage === true
      ? { contact: { contactId: speaker.id, displayName: speaker.name } }
      : {}),
  });
  const variables = buildDynamicPromptTemplateVariables({
    ...BASE_DYNAMIC_INPUT,
    message,
    conversationScope: turnConversationScope,
    resolvedUserName: speaker.name,
    trustLevel: speaker.trustLevel,
    relationshipType: speaker.isMachineIntelligence ? 'ai_companion' : 'friend',
    channelType,
    canonicalContactKey: speaker.id,
    templateVariables,
    ...(options.taskKind ? { taskKind: options.taskKind } : {}),
    ...(options.recentChannelEntries ? { recentChannelEntries: options.recentChannelEntries } : {}),
  });
  // Mirror the runtime path (prompt-assembly): each seeded runtime layer is a
  // final render unit with its required/optional policy (E2.5).
  const mergedVariables = { ...templateVariables, ...variables };
  const prompt = getDefaultRuntimePromptSections()
    .map(section => renderFinalPromptSection(section.content, {
      now: FIXTURE_NOW,
      variables: mergedVariables,
      sectionLabel: section.identifier,
      required: section.required,
    }))
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n');
  return { prompt, variables };
}

// ---------------------------------------------------------------------------
// Memory fixtures + in-memory store for leak probes
// ---------------------------------------------------------------------------

export interface ScopedMemory extends PurrMemory {
  similarity: number;
}

let memoryCounter = 0;

export function makeScopedMemory(
  text: string,
  scopeRef: MemoryScopeRef,
  overrides: Partial<ScopedMemory> = {},
): ScopedMemory {
  memoryCounter += 1;
  return {
    id: overrides.id ?? `group-harness-mem-${memoryCounter}`,
    text,
    type: overrides.type ?? 'semantic',
    importance: overrides.importance ?? 0.9,
    confidence: overrides.confidence ?? 0.95,
    emotionalValence: overrides.emotionalValence ?? 0,
    salience: overrides.salience ?? 0.9,
    sourceRef: overrides.sourceRef ?? `${scopeRef.kind}:${scopeRef.id}`,
    extractedAt: overrides.extractedAt ?? Date.now(),
    lastAccessed: overrides.lastAccessed ?? Date.now(),
    accessCount: overrides.accessCount ?? 0,
    tags: overrides.tags ?? [],
    scopeRef,
    scopeTags: overrides.scopeTags ?? [`${scopeRef.kind}:${scopeRef.id}`],
    provenance: overrides.provenance ?? { channelId: scopeRef.id },
    sensitivity: overrides.sensitivity ?? 'personal',
    consentFlags: overrides.consentFlags ?? ({} as ConsentFlags),
    contactId: overrides.contactId,
    similarity: overrides.similarity ?? 0.9,
  };
}

export function conversationScope(id: string): MemoryScopeRef {
  return { kind: 'conversation', id };
}

/** Distinct sentinel memories per conversation scope for leak probing. */
export const MEMORY_SENTINELS = {
  dmAlice: 'Alice raise negotiation target is 12 percent',
  roomTownsquare: 'Offsite venue shortlist for the townsquare group',
  roomBackchannel: 'Backchannel room complaint about the townsquare plan',
  dmDanaNonMember: 'Dana private relocation plans discussed one on one',
} as const;

export function makeLeakProbeMemories(): ScopedMemory[] {
  return [
    makeScopedMemory(MEMORY_SENTINELS.dmAlice, conversationScope(dmChannelId(ALICE))),
    makeScopedMemory(MEMORY_SENTINELS.roomTownsquare, conversationScope(GROUP_ROOM_ID)),
    makeScopedMemory(MEMORY_SENTINELS.roomBackchannel, conversationScope(OTHER_ROOM_ID)),
    makeScopedMemory(MEMORY_SENTINELS.dmDanaNonMember, conversationScope(dmChannelId(DANA))),
  ];
}

/**
 * In-memory MemoryStore double whose `searchByEmbedding` returns all fixture
 * memories (matching the canonical privacy-regression pattern). The REAL
 * retrieval gates (room visibility, scope, trust/sensitivity) run inside
 * MemoryRetriever, so this exercises the actual retrieval path rather than
 * mocking its output.
 */
export function makeLeakProbeStore(memories: ScopedMemory[]): MemoryStore {
  return {
    searchByEmbedding: () => memories,
    updateMemory: () => undefined,
    getContactProfile: () => undefined,
    getMemoriesByContact: () => [],
    getMemoriesByChannel: () => [],
    getAllActiveMemories: () => memories,
    listActiveMemories: async () => memories,
  } as unknown as MemoryStore;
}

export function makeEmbeddingProvider(): EmbeddingProviderPort {
  return {
    embed: async () => new Float32Array(1024),
    embedBatch: async () => [],
    dims: 1024,
  } as unknown as EmbeddingProviderPort;
}

// ---------------------------------------------------------------------------
// Author-context resolution (peer-companion binding correctness)
// ---------------------------------------------------------------------------

/**
 * Minimal ContactStorePort double for resolveAuthorContext. Resolves the
 * synthetic harness contacts by their `api` channel identity so the REAL
 * author-context resolution (trust, relationship, machine-intelligence flag,
 * canonical binding) runs against live-shaped contact records.
 */
export function makeAuthorContextContactStore(): ContactStorePort {
  const contacts = makeGroupChatContacts();
  const byAuthorId = new Map<string, Contact>();
  for (const contact of contacts.values()) {
    for (const identity of contact.channelIdentities ?? []) {
      byAuthorId.set(identity.userId, contact);
    }
  }
  return {
    getById: async (id: string) => contacts.get(id),
    getByChannelIdentity: async (_channel: string, userId: string) => byAuthorId.get(userId),
    resolveChannelIdentity: async (_channel: string, userId: string, _name?: string) => {
      const contact = byAuthorId.get(userId);
      if (!contact) {
        throw new Error(`Unknown harness channel identity: ${userId}`);
      }
      return contact;
    },
    updateLastSeen: async () => undefined,
    recordChannelActivity: async () => undefined,
    getConversationChannelPrivacy: async () => undefined,
  } as unknown as ContactStorePort;
}

/**
 * Resolve author context for a harness participant on a given channel through
 * the REAL resolveAuthorContext path. Used to prove that a peer companion in a
 * genuine DM binds normally (canonicalContactKey + machine-intelligence flag)
 * while a companion speaking in a room is never bound as the canonical human.
 */
export function resolveHarnessAuthorContext(
  speaker: HarnessParticipant,
  channelId: string,
  isDirectMessage: boolean,
): Promise<ResolvedAuthorContext> {
  const message: SubstrateMessage = makeMessage({
    channelId,
    channelType: 'api',
    isDirectMessage,
    authorId: speaker.authorId,
    authorName: speaker.name,
  });
  return resolveAuthorContext({
    message,
    contactStore: makeAuthorContextContactStore(),
    logger: { warn: () => undefined, debug: () => undefined, info: () => undefined },
    companionIdentityKey: 'companion-self',
    companionDisplayName: 'Companion',
  });
}

// ---------------------------------------------------------------------------
// Group-memory classification (extraction weighting of the peer companion)
// ---------------------------------------------------------------------------

/**
 * Run the REAL group-memory classifier over the synthetic room window so the
 * peer companion's extraction weighting is provable: humans drive group-mode
 * detection, and the companion is surfaced as a machine-intelligence
 * participant only when `includeAiCompanions` is enabled.
 */
export function classifyHarnessRoomGroupMemory(
  options: { includeAiCompanions: boolean },
): Promise<GroupMemoryClassification> {
  const contactStore = makeAuthorContextContactStore();
  const defaults = createDefaultGroupMemorySettings();
  return classifyGroupMemoryChannel({
    channelId: GROUP_ROOM_ID,
    channelType: 'api',
    contactStore: { getByChannelIdentity: contactStore.getByChannelIdentity.bind(contactStore) },
    recentEntries: makeGroupRoomRecentEntries(),
    channelTopology: { kind: 'group_channel' },
    groupMemory: {
      ...defaults,
      enabled: true,
      memoryMode: 'auto',
      autoDetection: {
        ...defaults.autoDetection,
        includeAiCompanions: options.includeAiCompanions,
      },
    },
  });
}
