import type { ContactStore } from '../../../core/contacts/store.js';
import { resolvePreferredContactName } from '../../../core/contacts/preferred-name.js';
import { looksLikeOpaqueIdentifier } from '../../../core/contacts/store/identity-utils.js';
import type { Contact, RelationshipType } from '../../../core/contacts/types.js';
import type { MemoryStore } from '../store.js';
import type { ExtractedFact, PurrMemory } from '../types.js';

const NAME_PATTERN = String.raw`([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})`;
const RELATIONSHIP_KEYWORD_PATTERN = String.raw`partner|spouse|wife|husband|boyfriend|girlfriend|friend|best friend|family|sister|brother|mom|mother|dad|father|parent|son|daughter|child|cousin|aunt|uncle|coworker|colleague|classmate|neighbor|roommate`;

const RELATIONSHIP_BEFORE_NAME = new RegExp(
  String.raw`\b(${RELATIONSHIP_KEYWORD_PATTERN})\b(?:\s+(?:named|called))?\s+${NAME_PATTERN}`,
  'u',
);
const NAME_BEFORE_RELATIONSHIP = new RegExp(
  String.raw`${NAME_PATTERN}\s+(?:is|was)\s+[^.]{0,40}?\b(${RELATIONSHIP_KEYWORD_PATTERN})\b`,
  'u',
);
const CAPITALIZED_NAME = new RegExp(NAME_PATTERN, 'gu');

const GENERIC_MENTION_NAMES = new Set([
  'assistant',
  'companion',
  'friend',
  'family',
  'mom',
  'mother',
  'dad',
  'father',
  'parent',
  'partner',
  'roommate',
  'sibling',
  'someone',
  'stranger',
  'the assistant',
  'the companion',
  'the user',
  'user',
]);

const RELATIONSHIP_PRIORITY: Readonly<Record<RelationshipType, number>> = {
  stranger: 0,
  acquaintance: 1,
  friend: 2,
  family: 3,
  partner: 4,
  ai_companion: 5,
};

export interface MentionOnlyContactCandidate {
  name: string;
  relationshipType: RelationshipType;
  normalizedKey: string;
}

interface ResolveMentionOnlyContactParams {
  fact: ExtractedFact;
  channelId: string;
  canonicalContactId?: string;
  canonicalContactName?: string;
  companionName?: string;
  contactStore: Pick<ContactStore, 'listAll' | 'upsert' | 'updateRelationshipType'> | null;
  memoryStore: Pick<MemoryStore, 'getMemoriesByChannel' | 'updateMemory'>;
}

function normalizeNameKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCandidateName(value: string): string {
  return value
    .replace(/['’]s$/iu, '')
    .replace(/[.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferRelationshipTypeFromKeyword(keyword: string): RelationshipType {
  const normalized = keyword.trim().toLowerCase();
  if ([
    'partner',
    'spouse',
    'wife',
    'husband',
    'boyfriend',
    'girlfriend',
  ].includes(normalized)) {
    return 'partner';
  }
  if ([
    'family',
    'sister',
    'brother',
    'mom',
    'mother',
    'dad',
    'father',
    'parent',
    'son',
    'daughter',
    'child',
    'cousin',
    'aunt',
    'uncle',
  ].includes(normalized)) {
    return 'family';
  }
  if (normalized === 'friend' || normalized === 'best friend') {
    return 'friend';
  }
  return 'acquaintance';
}

function inferRelationshipTypeFromFact(fact: ExtractedFact): RelationshipType | undefined {
  const normalizedTags = fact.tags.map(tag => tag.trim().toLowerCase());
  if (normalizedTags.includes('family')) return 'family';
  if (normalizedTags.includes('friend')) return 'friend';
  if (
    normalizedTags.includes('partner')
    || normalizedTags.includes('spouse')
    || normalizedTags.includes('wife')
    || normalizedTags.includes('husband')
    || normalizedTags.includes('boyfriend')
    || normalizedTags.includes('girlfriend')
  ) {
    return 'partner';
  }
  if (normalizedTags.includes('coworker') || normalizedTags.includes('colleague')) {
    return 'acquaintance';
  }

  const lowerText = fact.text.toLowerCase();
  if (/\b(friend|best friend)\b/.test(lowerText)) return 'friend';
  if (/\b(family|sister|brother|mom|mother|dad|father|parent|son|daughter|child|cousin|aunt|uncle)\b/.test(lowerText)) {
    return 'family';
  }
  if (/\b(partner|spouse|wife|husband|boyfriend|girlfriend)\b/.test(lowerText)) {
    return 'partner';
  }
  if (/\b(coworker|colleague|classmate|neighbor|roommate)\b/.test(lowerText)) {
    return 'acquaintance';
  }
  return undefined;
}

function isExcludedCandidateName(
  name: string,
  excludedNames: readonly string[],
): boolean {
  const normalized = normalizeNameKey(name);
  if (!normalized) return true;
  if (GENERIC_MENTION_NAMES.has(normalized)) return true;
  if (looksLikeOpaqueIdentifier(name)) return true;
  return excludedNames.some(excluded => normalizeNameKey(excluded) === normalized);
}

export function extractMentionOnlyContactCandidate(params: {
  fact: ExtractedFact;
  canonicalContactName?: string;
  companionName?: string;
}): MentionOnlyContactCandidate | undefined {
  if (params.fact.type !== 'relational') return undefined;

  const excludedNames = [
    params.canonicalContactName,
    params.companionName,
  ].filter((value): value is string => Boolean(value?.trim()));

  const inferredRelationship = inferRelationshipTypeFromFact(params.fact);
  if (!inferredRelationship || inferredRelationship === 'ai_companion') return undefined;

  const relationBeforeName = RELATIONSHIP_BEFORE_NAME.exec(params.fact.text);
  if (relationBeforeName) {
    const [, relationKeyword, relationName] = relationBeforeName;
    const candidateName = cleanCandidateName(relationName);
    if (!isExcludedCandidateName(candidateName, excludedNames)) {
      return {
        name: candidateName,
        relationshipType: inferRelationshipTypeFromKeyword(relationKeyword),
        normalizedKey: normalizeNameKey(candidateName),
      };
    }
  }

  const nameBeforeRelationship = NAME_BEFORE_RELATIONSHIP.exec(params.fact.text);
  if (nameBeforeRelationship) {
    const [, relationName, relationKeyword] = nameBeforeRelationship;
    const candidateName = cleanCandidateName(relationName);
    if (!isExcludedCandidateName(candidateName, excludedNames)) {
      return {
        name: candidateName,
        relationshipType: inferRelationshipTypeFromKeyword(relationKeyword),
        normalizedKey: normalizeNameKey(candidateName),
      };
    }
  }

  for (const match of params.fact.text.matchAll(CAPITALIZED_NAME)) {
    const [, matchedName] = match;
    const candidateName = cleanCandidateName(matchedName);
    if (isExcludedCandidateName(candidateName, excludedNames)) continue;
    return {
      name: candidateName,
      relationshipType: inferredRelationship,
      normalizedKey: normalizeNameKey(candidateName),
    };
  }

  return undefined;
}

function getPreferredContactName(contact: Pick<Contact, 'displayName' | 'nickname'>): string {
  return resolvePreferredContactName(contact, contact.displayName) ?? contact.displayName;
}

function findExistingMentionOnlyContact(
  contacts: readonly Contact[],
  candidate: MentionOnlyContactCandidate,
): Contact | undefined {
  return contacts.find(contact => normalizeNameKey(getPreferredContactName(contact)) === candidate.normalizedKey);
}

function shouldPromoteRelationship(
  current: RelationshipType,
  next: RelationshipType,
): boolean {
  return RELATIONSHIP_PRIORITY[next] > RELATIONSHIP_PRIORITY[current];
}

function candidateMatchesMemory(
  memory: Pick<PurrMemory, 'text' | 'type' | 'tags'>,
  candidate: MentionOnlyContactCandidate,
  excludedNames: {
    canonicalContactName?: string;
    companionName?: string;
  },
): boolean {
  if (memory.type !== 'relational') return false;
  const memoryCandidate = extractMentionOnlyContactCandidate({
    fact: {
      text: memory.text,
      type: memory.type,
      importance: 0.5,
      emotionalValence: 0,
      confidence: 0.5,
      tags: memory.tags,
    },
    canonicalContactName: excludedNames.canonicalContactName,
    companionName: excludedNames.companionName,
  });
  return memoryCandidate?.normalizedKey === candidate.normalizedKey;
}

function relinkRecurringMemories(params: {
  memoryStore: Pick<MemoryStore, 'updateMemory'>;
  candidate: MentionOnlyContactCandidate;
  contactId: string;
  canonicalContactId?: string;
  channelMemories: readonly PurrMemory[];
  canonicalContactName?: string;
  companionName?: string;
}): void {
  for (const memory of params.channelMemories) {
    if (!candidateMatchesMemory(memory, params.candidate, params)) continue;
    if (memory.contactId && memory.contactId !== params.canonicalContactId) continue;
    if (memory.contactId === params.contactId) continue;
    params.memoryStore.updateMemory(memory.id, { contactId: params.contactId });
  }
}

export function resolveMentionOnlyContactForFact(
  params: ResolveMentionOnlyContactParams,
): Contact | undefined {
  if (!params.contactStore) return undefined;
  if (typeof params.contactStore.listAll !== 'function' || typeof params.contactStore.upsert !== 'function') {
    return undefined;
  }

  const candidate = extractMentionOnlyContactCandidate({
    fact: params.fact,
    canonicalContactName: params.canonicalContactName,
    companionName: params.companionName,
  });
  if (!candidate) return undefined;

  const contacts = params.contactStore.listAll();
  const existing = findExistingMentionOnlyContact(contacts, candidate);
  const channelMemories = params.memoryStore.getMemoriesByChannel(params.channelId, 50);

  if (existing) {
    if (
      typeof params.contactStore.updateRelationshipType === 'function'
      && shouldPromoteRelationship(existing.relationshipType, candidate.relationshipType)
    ) {
      params.contactStore.updateRelationshipType(
        existing.id,
        candidate.relationshipType,
        'system:memory_extraction:mention_contact',
      );
    }
    relinkRecurringMemories({
      memoryStore: params.memoryStore,
      candidate,
      contactId: existing.id,
      canonicalContactId: params.canonicalContactId,
      channelMemories,
      canonicalContactName: params.canonicalContactName,
      companionName: params.companionName,
    });
    return existing;
  }

  const priorMentions = channelMemories.filter(memory => candidateMatchesMemory(memory, candidate, params));
  if (priorMentions.length + 1 < 2) {
    return undefined;
  }

  const created = params.contactStore.upsert(
    {
      displayName: candidate.name,
      relationshipType: candidate.relationshipType,
    },
    {
      actor: 'system:memory_extraction:mention_contact',
    },
  );

  relinkRecurringMemories({
    memoryStore: params.memoryStore,
    candidate,
    contactId: created.id,
    canonicalContactId: params.canonicalContactId,
    channelMemories,
    canonicalContactName: params.canonicalContactName,
    companionName: params.companionName,
  });

  return created;
}

export const __test = {
  extractMentionOnlyContactCandidate,
};
