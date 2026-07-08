import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { isHighTierTrustLevel } from '../../../system/trust/types.js';
import type { ChannelDisclosureContext, ChannelMeta } from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact, SocialRelationshipEdge } from '../../../core/contacts/types.js';
import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import { cloneMemory } from '../../../core/turns/snapshot.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import { evaluateRetrievalAccessDecision, type RetrievalRoomVisibilityContext } from './access.js';
import {
  mergeRetrievalContactContext,
  normalizeRelationCue,
  querySuggestsContactFocus,
} from './social.js';
import { clamp, tokenizeForExplicitMatch } from './scoring.js';
import type {
  RetrievalContactContext,
  RetrievalSocialContext,
  ScoredMemory,
} from './types.js';

const EVOLUTION_CHAIN_SELECTED_LIMIT = 3;
const EVOLUTION_CHAIN_PER_MEMORY_LIMIT = 3;
const EVOLUTION_CHAIN_USEFUL_HINT = /\b(history|lineage|changed|change|updated|update|previous|old|correction|corrected|conflict|contradict|superseded|why)\b/i;

export async function resolveEmotionalSnapshot(
  contactStore: ContactStorePort | null,
  contactId: string,
): Promise<EmotionalSnapshot | undefined> {
  if (!contactStore) return undefined;

  const directSnapshot = await contactStore.getEmotionalSnapshot(contactId);
  if (directSnapshot) return directSnapshot;

  const contact = await contactStore.getById(contactId);
  if (!contact?.emotionalBaseline) return undefined;

  const baselineRaw = contact.emotionalBaseline;
  const baselineValence = clamp(baselineRaw.valenceBaseline, -1, 1);
  const moodValence = clamp(baselineRaw.moodValence, -1, 1);
  const moodDrift = Number.isFinite(baselineRaw.moodDrift)
    ? clamp(baselineRaw.moodDrift, -1, 1)
    : clamp(moodValence - baselineValence, -1, 1);
  const moodSamples = Number.isFinite(baselineRaw.moodSamples)
    ? Math.max(0, Math.floor(baselineRaw.moodSamples))
    : 0;
  const lastMoodUpdateEpochMs = Number.isFinite(baselineRaw.lastMoodUpdateEpochMs)
    ? Math.max(0, Math.floor(baselineRaw.lastMoodUpdateEpochMs))
    : undefined;

  if (
    moodSamples === 0
    && Math.abs(baselineValence) < 1e-6
    && Math.abs(moodValence) < 1e-6
    && lastMoodUpdateEpochMs === undefined
  ) {
    return undefined;
  }

  return {
    baselineValence,
    moodValence,
    moodDrift,
    moodSamples,
    lastMoodUpdateEpochMs,
  };
}

export async function resolveRetrievalSocialContext(
  contactStore: ContactStorePort | null,
  canonicalContactId: string,
  trustLevel: TrustLevel,
  channelPrivacy: ChannelPrivacy,
): Promise<RetrievalSocialContext | undefined> {
  if (!contactStore) return undefined;

  const canonicalContact = await contactStore.getById(canonicalContactId);
  if (!canonicalContact) return undefined;

  const canonicalEntity = await contactStore.getSocialGraphEntityByContactId(canonicalContactId);
  if (!canonicalEntity) {
    return {
      canonicalContactId,
      canonicalDisplayName: canonicalContact.displayName,
      relatedContactsById: new Map(),
    };
  }

  const edges = await contactStore.listSocialRelationshipEdges({
    contactId: canonicalContactId,
    viewerTrustLevel: trustLevel,
    viewerChannelPrivacy: channelPrivacy,
  });
  const relatedContactsById = new Map<string, RetrievalContactContext>();
  for (const edge of edges) {
    const relatedContact = await resolveRelatedContactFromEdge(
      contactStore,
      canonicalEntity.id,
      edge,
    );
    if (!relatedContact) continue;

    const existing = relatedContactsById.get(relatedContact.id);
    relatedContactsById.set(
      relatedContact.id,
      mergeRetrievalContactContext(
        existing,
        buildRelatedContactContext(relatedContact, edge),
      ),
    );
  }

  return {
    canonicalContactId,
    canonicalDisplayName: canonicalContact.displayName,
    relatedContactsById,
  };
}

export async function buildSelectedContactContext(
  contactStore: ContactStorePort | null,
  selected: readonly ScoredMemory[],
  socialContext?: RetrievalSocialContext,
): Promise<ReadonlyMap<string, RetrievalContactContext> | undefined> {
  if (!contactStore) {
    return socialContext?.relatedContactsById;
  }

  const contexts = new Map<string, RetrievalContactContext>(socialContext?.relatedContactsById ?? []);
  for (const item of selected) {
    const contactId = item.memory.contactId?.trim();
    if (!contactId || contactId === socialContext?.canonicalContactId || contexts.has(contactId)) {
      continue;
    }
    const contact = await contactStore.getById(contactId);
    if (!contact) continue;
    contexts.set(contactId, {
      contactId,
      displayName: contact.displayName,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      relationshipLabels: [],
      relatedToCanonical: false,
    });
  }

  return contexts.size > 0 ? contexts : undefined;
}

export async function attachEvolutionChains(
  memoryStore: MemoryStorePort,
  selected: readonly ScoredMemory[],
  options: {
    contextText: string;
    trustLevel: TrustLevel;
    channelPrivacy: ChannelPrivacy;
    broadcast: boolean;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval: boolean;
    roomVisibility?: RetrievalRoomVisibilityContext;
  },
  isMemoryQuarantined: (memory: PurrMemory) => boolean,
): Promise<ScoredMemory[]> {
  if (!shouldExpandEvolutionChains(options)) {
    return [...selected];
  }

  const expanded = [...selected];
  const selectedIds = new Set(expanded.map(item => item.memory.id));
  for (let index = 0; index < Math.min(expanded.length, EVOLUTION_CHAIN_SELECTED_LIMIT); index++) {
    const item = expanded[index];
    const links = (await memoryStore.getEvolutionLinksForSourceMemory(item.memory.id))
      .slice(0, EVOLUTION_CHAIN_PER_MEMORY_LIMIT);
    const chain: NonNullable<ScoredMemory['evolutionChain']> = [];
    for (const link of links) {
      if (selectedIds.has(link.targetMemoryId)) continue;
      const target = await memoryStore.getById(link.targetMemoryId);
      if (!target || target.deletedAt !== undefined) continue;
      if (isMemoryQuarantined(target)) continue;
      const accessDecision = evaluateRetrievalAccessDecision(target, {
        trustLevel: options.trustLevel,
        channelPrivacy: options.channelPrivacy,
        broadcast: options.broadcast,
        channelMeta: options.channelMeta,
        canonicalContactId: options.canonicalContactId,
        operatorApproval: options.operatorApproval,
        roomVisibility: options.roomVisibility,
      });
      if (!accessDecision.allowed) continue;
      chain.push({
        relation: link.relation,
        confidence: link.confidence,
        reason: link.reason,
        memory: target,
      });
    }
    if (chain.length > 0) {
      expanded[index] = {
        ...item,
        evolutionChain: chain,
      };
    }
  }

  return expanded;
}

export async function applySocialContextRankingAdjustments(
  contactStore: ContactStorePort | null,
  candidates: readonly ScoredMemory[],
  contextText: string,
  socialContext?: RetrievalSocialContext,
): Promise<ScoredMemory[]> {
  if (!socialContext) return [...candidates];

  const queryTokens = new Set(tokenizeForExplicitMatch(contextText));
  const adjusted = await Promise.all(candidates.map(async candidate => ({
    ...candidate,
    score: candidate.score * await resolveSocialContextScoreMultiplier(
      contactStore,
      candidate.memory,
      queryTokens,
      socialContext,
    ),
  })));
  return adjusted.sort((left, right) => right.score - left.score);
}

export async function collectEmotionalContinuityMemories(
  memoryStore: MemoryStorePort,
  canonicalContactId: string,
  trustLevel: TrustLevel,
  channelDisclosure: ChannelDisclosureContext,
  selectedIds: ReadonlySet<string>,
  operatorApproval: boolean,
  channelMeta: ChannelMeta | undefined,
  sourceOverride: readonly PurrMemory[] | undefined,
  roomVisibility: RetrievalRoomVisibilityContext | undefined,
  filterQuarantinedMemories: (memories: readonly PurrMemory[]) => PurrMemory[],
): Promise<PurrMemory[]> {
  const source = filterQuarantinedMemories(
    (sourceOverride?.map(cloneMemory) ?? await collectContactEmotionalMemories(memoryStore, canonicalContactId))
      .filter(memory => !isInternalMemoryArtifact(memory)),
  );
  if (source.length === 0) return [];

  return source
    .filter(memory => memory.type === 'emotional')
    .filter(memory => !selectedIds.has(memory.id))
    .filter((memory) => evaluateRetrievalAccessDecision(memory, {
      trustLevel,
      channelPrivacy: channelDisclosure.channelPrivacy,
      broadcast: channelDisclosure.broadcast,
      channelMeta,
      canonicalContactId,
      operatorApproval,
      roomVisibility,
    }).allowed)
    .sort((left, right) => right.extractedAt - left.extractedAt)
    .slice(0, 3);
}

export async function collectContactEmotionalMemories(
  memoryStore: MemoryStorePort,
  canonicalContactId: string,
): Promise<PurrMemory[]> {
  return (await memoryStore
    .getMemoriesByContact(canonicalContactId, 12))
    .filter(memory => !isInternalMemoryArtifact(memory));
}

export async function collectProactiveRecallCandidates(
  memoryStore: MemoryStorePort,
  channelId: string,
  canonicalContactId?: string,
): Promise<PurrMemory[]> {
  if (canonicalContactId) {
    const byContact = (await memoryStore
      .getMemoriesByContact(canonicalContactId, 24))
      .filter(memory => !isInternalMemoryArtifact(memory));
    if (byContact.length > 0) return byContact;
  }

  const byChannel = (await memoryStore
    .getMemoriesByChannel(channelId, 24))
    .filter(memory => !isInternalMemoryArtifact(memory));
  if (byChannel.length > 0) return byChannel;

  return (await memoryStore
    .getAllActiveMemories())
    .filter(memory => !isInternalMemoryArtifact(memory))
    .sort((left, right) => right.lastAccessed - left.lastAccessed)
    .slice(0, 24);
}

function shouldExpandEvolutionChains(input: {
  contextText: string;
  trustLevel: TrustLevel;
  channelPrivacy: ChannelPrivacy;
}): boolean {
  return input.channelPrivacy === 'private'
    && isHighTierTrustLevel(input.trustLevel)
    && EVOLUTION_CHAIN_USEFUL_HINT.test(input.contextText);
}

async function resolveRelatedContactFromEdge(
  contactStore: ContactStorePort,
  canonicalEntityId: string,
  edge: SocialRelationshipEdge,
): Promise<Contact | undefined> {
  const otherEntityId = edge.sourceEntityId === canonicalEntityId
    ? edge.targetEntityId
    : edge.sourceEntityId;
  const otherEntity = await contactStore.getSocialGraphEntityById(otherEntityId);
  if (!otherEntity?.contactId) return undefined;
  return contactStore.getById(otherEntity.contactId);
}

function buildRelatedContactContext(
  contact: Contact,
  edge: SocialRelationshipEdge,
): RetrievalContactContext {
  return {
    contactId: contact.id,
    displayName: contact.displayName,
    trustLevel: contact.trustLevel,
    relationshipType: contact.relationshipType,
    relationshipLabels: [normalizeRelationCue(edge.relationshipType)],
    relatedToCanonical: true,
  };
}

async function resolveSocialContextScoreMultiplier(
  contactStore: ContactStorePort | null,
  memory: Pick<PurrMemory, 'contactId'>,
  queryTokens: ReadonlySet<string>,
  socialContext: RetrievalSocialContext,
): Promise<number> {
  const contactId = memory.contactId?.trim();
  if (!contactId) return 1;
  if (contactId === socialContext.canonicalContactId) return 1.1;

  const related = socialContext.relatedContactsById.get(contactId);
  if (related) {
    return querySuggestsContactFocus(queryTokens, related) ? 1.05 : 0.85;
  }

  const contact = contactStore ? await contactStore.getById(contactId) : undefined;
  if (contact && querySuggestsContactFocus(queryTokens, {
    displayName: contact.displayName,
    relationshipType: contact.relationshipType,
    relationshipLabels: [],
  })) {
    return 0.9;
  }

  return 0.45;
}
