import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import { cloneRecentContactShapeArtifact } from '../../../core/turns/snapshot.js';
import type { RecentContactShapeArtifact, MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import type {
  RetrievalAccessScope,
} from '../types.js';
import { resolveMemoriesByIds } from './memory-batch.js';
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

export interface RecentContactShapeAccessResult {
  recentContactShape?: RecentContactShapeArtifact;
  authorizedSourceMemories: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  withheldSourceMemoryIds: string[];
}

function canonicalContactRooms(contact: Contact | undefined): Set<string> {
  const roomIds = new Set<string>();
  for (const conversation of contact?.conversationChannels ?? []) {
    const roomId = conversation.channelId.trim();
    if (roomId.length > 0) roomIds.add(roomId);
  }
  return roomIds;
}

/**
 * Room visibility for recall (psfn-framework-bd9tx). The turn ConversationScope
 * is the sole room authority: the room id and kind come only from it, and loose
 * channel metadata is never consulted. A DM scope's canonical contact must agree
 * with the recall's canonical contact; an inconsistent scope throws. Without a
 * scope the room kind is unknown, so DM-only allowances fail closed.
 */
export async function resolveRoomVisibilityContext(input: {
  contactStore: ContactStorePort | null;
  channelId: string;
  canonicalContactId: string | undefined;
  conversationScope: ConversationScope | undefined;
}): Promise<RetrievalRoomVisibilityContext> {
  const scope = input.conversationScope;
  if (!scope) {
    return { currentChannelId: input.channelId };
  }
  const scopeRoomId = scope.channelId.trim();
  if (!scopeRoomId) {
    throw new Error('Recall ConversationScope has no room id; refusing room-visibility gating');
  }
  if (scope.kind !== 'dm') {
    return { currentChannelId: scopeRoomId, conversationScope: scope };
  }
  const scopeContactId = scope.contact.contactId.trim();
  const recallContactId = input.canonicalContactId?.trim();
  if (!scopeContactId || (recallContactId && recallContactId !== scopeContactId)) {
    throw new Error('Recall canonical contact conflicts with the DM ConversationScope contact');
  }
  const contact = input.contactStore ? await input.contactStore.getById(scopeContactId) : undefined;
  const roomIds = canonicalContactRooms(contact);
  return {
    currentChannelId: scopeRoomId,
    ...(roomIds.size > 0 ? { canonicalContactRoomIds: roomIds } : {}),
    conversationScope: scope,
  };
}

export async function resolveRecentContactShapeAccess(input: {
  memoryStore: MemoryStorePort;
  sessionQuarantineFilter: MemorySessionQuarantineFilter | null;
  recentContactShape: RecentContactShapeArtifact | undefined;
  options: {
    accessScope?: RetrievalAccessScope;
    trustLevel: TrustLevel;
    channelPrivacy: ChannelPrivacy;
    broadcast: boolean;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
    roomVisibility?: RetrievalRoomVisibilityContext;
  };
  now?: number;
}): Promise<RecentContactShapeAccessResult> {
  const shape = input.recentContactShape;
  if (!shape) {
    return { authorizedSourceMemories: [], withheldSourceMemoryIds: [] };
  }

  if (shape.freshUntil <= (input.now ?? Date.now())) {
    return { authorizedSourceMemories: [], withheldSourceMemoryIds: [...shape.sourceMemoryIds] };
  }
  if (
    !input.options.canonicalContactId
    || shape.contactId !== input.options.canonicalContactId
  ) {
    return { authorizedSourceMemories: [], withheldSourceMemoryIds: [...shape.sourceMemoryIds] };
  }

  const sourceMemoryIds = shape.sourceMemoryIds
    .map(id => id.trim())
    .filter(Boolean);
  if (sourceMemoryIds.length === 0
    || (typeof input.memoryStore.getById !== 'function'
      && typeof input.memoryStore.getByIds !== 'function')) {
    return { authorizedSourceMemories: [], withheldSourceMemoryIds: sourceMemoryIds };
  }

  const sourceMemories = (await resolveMemoriesByIds(input.memoryStore, sourceMemoryIds))
    .map(memory => ({ ...memory, similarity: 1 }));
  if (sourceMemories.length !== sourceMemoryIds.length) {
    const loadedIds = new Set(sourceMemories.map(memory => memory.id));
    return {
      authorizedSourceMemories: [],
      withheldSourceMemoryIds: sourceMemoryIds.filter(id => !loadedIds.has(id)),
    };
  }

  const sourceClassifications = await Promise.all(
    sourceMemories.map(memory => input.memoryStore.getMemorySubjectClassification(memory.id)),
  );
  const mismatchedSubjectIds = sourceMemories.flatMap((memory, index) => {
    const classification = sourceClassifications[index];
    return classification?.status === 'current'
      && classification.subjectClass === 'single_contact'
      && classification.subjectContactIds.length === 1
      && classification.subjectContactIds[0] === shape.contactId
      ? []
      : [memory.id];
  });
  if (mismatchedSubjectIds.length > 0) {
    return {
      authorizedSourceMemories: [],
      withheldSourceMemoryIds: mismatchedSubjectIds,
    };
  }

  const quarantine = summarizeQuarantinedMemories(input.sessionQuarantineFilter, sourceMemories);
  const { summary, withheldIds } = summarizeWithheldMemories(sourceMemories, input.options);
  const withheldSummary = mergeMemoryWithheldSummaries(quarantine.summary, summary);
  const blockedIds = [...new Set([...quarantine.withheldIds, ...withheldIds])];
  if (blockedIds.length === 0) {
    return {
      recentContactShape: cloneRecentContactShapeArtifact(shape),
      authorizedSourceMemories: sourceMemories.map(memory => ({ ...memory })),
      withheldSourceMemoryIds: [],
    };
  }

  return {
    authorizedSourceMemories: [],
    withheldSummary,
    withheldSourceMemoryIds: blockedIds,
  };
}
