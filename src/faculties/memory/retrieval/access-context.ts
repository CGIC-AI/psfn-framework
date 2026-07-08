import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import { cloneContactProfileArtifact } from '../../../core/turns/snapshot.js';
import type { ContactProfileArtifact, MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import {
  mergeMemoryWithheldSummaries,
  summarizeWithheldMemories,
  type RetrievalRoomVisibilityContext,
} from './access.js';
import {
  summarizeQuarantinedMemories,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';

export interface ContactProfileAccessResult {
  profile?: ContactProfileArtifact;
  withheldSummary?: MemoryWithheldSummary;
  withheldSourceMemoryIds: string[];
}

function buildRoomVisibilityContext(
  channelId: string,
  channelMeta: ChannelMeta | undefined,
  canonicalContact: Contact | undefined,
  conversationScope: ConversationScope | undefined,
): RetrievalRoomVisibilityContext {
  const canonicalContactRoomIds = new Set<string>();
  for (const conversation of canonicalContact?.conversationChannels ?? []) {
    const roomId = conversation.channelId.trim();
    if (roomId.length > 0) canonicalContactRoomIds.add(roomId);
  }

  // The turn ConversationScope is plumbed through as an available input
  // (E1 epic); the gating fields below intentionally keep deriving from
  // channelMeta and the canonical contact until a dependent bead flips the
  // room-visibility gate to consume the scope.
  return {
    currentChannelId: channelId,
    ...(channelMeta?.isDirectMessage !== undefined
      ? { currentIsDirectMessage: channelMeta.isDirectMessage }
      : {}),
    ...(canonicalContactRoomIds.size > 0 ? { canonicalContactRoomIds } : {}),
    ...(conversationScope ? { conversationScope } : {}),
  };
}

export async function resolveRoomVisibilityContext(input: {
  contactStore: ContactStorePort | null;
  channelId: string;
  channelMeta: ChannelMeta | undefined;
  canonicalContactId: string | undefined;
  conversationScope: ConversationScope | undefined;
}): Promise<RetrievalRoomVisibilityContext> {
  const canonicalContact = input.canonicalContactId && input.contactStore
    ? await input.contactStore.getById(input.canonicalContactId)
    : undefined;
  return buildRoomVisibilityContext(
    input.channelId,
    input.channelMeta,
    canonicalContact,
    input.conversationScope,
  );
}

export async function resolveContactProfileAccess(input: {
  memoryStore: MemoryStorePort;
  sessionQuarantineFilter: MemorySessionQuarantineFilter | null;
  profile: ContactProfileArtifact | undefined;
  options: {
    trustLevel: TrustLevel;
    channelPrivacy: ChannelPrivacy;
    broadcast: boolean;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
    roomVisibility?: RetrievalRoomVisibilityContext;
  };
}): Promise<ContactProfileAccessResult> {
  if (!input.profile) {
    return { withheldSourceMemoryIds: [] };
  }

  const sourceMemoryIds = input.profile.sourceMemoryIds
    .map(id => id.trim())
    .filter(Boolean);
  if (sourceMemoryIds.length === 0 || typeof input.memoryStore.getById !== 'function') {
    return { profile: cloneContactProfileArtifact(input.profile), withheldSourceMemoryIds: [] };
  }

  const sourceMemories = (
    await Promise.all(sourceMemoryIds.map(id => input.memoryStore.getById(id)))
  )
    .filter((memory): memory is PurrMemory => Boolean(memory))
    .map(memory => ({ ...memory, similarity: 1 }));
  if (sourceMemories.length === 0) {
    return { profile: cloneContactProfileArtifact(input.profile), withheldSourceMemoryIds: [] };
  }

  const quarantine = summarizeQuarantinedMemories(input.sessionQuarantineFilter, sourceMemories);
  const { summary, withheldIds } = summarizeWithheldMemories(sourceMemories, input.options);
  const withheldSummary = mergeMemoryWithheldSummaries(quarantine.summary, summary);
  const blockedIds = [...new Set([...quarantine.withheldIds, ...withheldIds])];
  if (blockedIds.length === 0) {
    return { profile: cloneContactProfileArtifact(input.profile), withheldSourceMemoryIds: [] };
  }

  return {
    withheldSummary,
    withheldSourceMemoryIds: blockedIds,
  };
}
