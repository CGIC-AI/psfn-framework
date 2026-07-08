import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { looksLikeOpaqueIdentifier } from '../../../core/contacts/store/identity-utils.js';
import type { Contact, RelationshipType } from '../../../core/contacts/types.js';
import type { MemoryStorePort } from '../memory-store-port.js';
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

// Relationship ceiling for the deliberate interlocutor auto-ratchet
// (psfn-framework-kada.1). A single extracted relational fact about the
// conversation partner's OWN bond with the companion may raise their
// relationshipType up to 'friend', but never beyond. 'family', 'partner', and
// 'ai_companion' are deliberately excluded: a single weak keyword/tag inference
// is not strong enough to justify them, and 'ai_companion' is never inferred
// from human relational language. Reaching those tiers stays a deliberate human
// action (admin API) or the primary-user promotion to 'partner' handled inside
// the contact store.
const INTERLOCUTOR_AUTO_RATCHET_TYPES: ReadonlySet<RelationshipType> = new Set([
  'acquaintance',
  'friend',
]);

// Second-person reference to the companion ("you", "you're", "your"). The
// interlocutor ratchet only fires when the relational evidence is addressed at
// the companion, not when it is generic relational chatter about other people.
const SECOND_PERSON_COMPANION_REFERENCE = /\byou\b|\byou['’]re\b|\byour\b|\byours\b/u;

// "you're my best friend" / "you are like family" — a second-person address that
// claims a relationship keyword.
const SECOND_PERSON_BOND = new RegExp(
  String.raw`\byou(?:['’]re| are| re)?\b[^.]{0,30}?\b(?:${RELATIONSHIP_KEYWORD_PATTERN})\b`,
  'u',
);

// "my best friend ..." / "our closest friend ..." — a first-person possessive
// claim over a relationship keyword (paired with a companion reference).
const FIRST_PERSON_POSSESSIVE_BOND = new RegExp(
  String.raw`\b(?:my|our)\b[^.]{0,30}?\b(?:${RELATIONSHIP_KEYWORD_PATTERN})\b`,
  'u',
);

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
  contactStore: Pick<ContactStorePort, 'listAll' | 'upsert' | 'updateRelationshipType'> | null;
  memoryStore: Pick<MemoryStorePort, 'getMemoriesByChannel' | 'updateMemory'>;
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

export function inferRelationshipTypeFromFact(fact: ExtractedFact): RelationshipType | undefined {
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
  canonicalContactNames?: readonly string[];
  companionName?: string;
}): MentionOnlyContactCandidate | undefined {
  if (params.fact.type !== 'relational') return undefined;

  const excludedNames = [
    params.canonicalContactName,
    ...(params.canonicalContactNames ?? []),
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

function contactNameKeys(contact: Pick<Contact, 'displayName' | 'nickname'>): Set<string> {
  const keys = new Set<string>();
  for (const name of [contact.displayName, contact.nickname]) {
    const key = name ? normalizeNameKey(name) : '';
    if (key) keys.add(key);
  }
  return keys;
}

function contactNames(contact: Pick<Contact, 'displayName' | 'nickname'> | undefined): string[] {
  if (!contact) return [];
  return [contact.displayName, contact.nickname]
    .filter((value): value is string => Boolean(value?.trim()));
}

function findExistingMentionOnlyContact(
  contacts: readonly Contact[],
  candidate: MentionOnlyContactCandidate,
): Contact | undefined {
  return contacts.find(contact => contactNameKeys(contact).has(candidate.normalizedKey));
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
    canonicalContactNames?: readonly string[];
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
    canonicalContactNames: excludedNames.canonicalContactNames,
    companionName: excludedNames.companionName,
  });
  return memoryCandidate?.normalizedKey === candidate.normalizedKey;
}

function relinkRecurringMemories(params: {
  memoryStore: Pick<MemoryStorePort, 'updateMemory'>;
  candidate: MentionOnlyContactCandidate;
  contactId: string;
  canonicalContactId?: string;
  channelMemories: readonly PurrMemory[];
  canonicalContactName?: string;
  canonicalContactNames?: readonly string[];
  companionName?: string;
}): Promise<void> {
  return (async () => {
  for (const memory of params.channelMemories) {
    if (!candidateMatchesMemory(memory, params.candidate, params)) continue;
    if (memory.contactId && memory.contactId !== params.canonicalContactId) continue;
    if (memory.contactId === params.contactId) continue;
    await params.memoryStore.updateMemory(memory.id, { contactId: params.contactId });
  }
  })();
}

export async function resolveMentionOnlyContactForFact(
  params: ResolveMentionOnlyContactParams,
) : Promise<Contact | undefined> {
  if (!params.contactStore) return undefined;
  if (typeof params.contactStore.listAll !== 'function' || typeof params.contactStore.upsert !== 'function') {
    return undefined;
  }

  const contacts = await params.contactStore.listAll();
  // Exclude every known name of the canonical contact (display name AND
  // nickname). Matching only the preferred name once minted a duplicate
  // channel-less contact whenever the canonical contact had a nickname.
  const canonicalContact = params.canonicalContactId
    ? contacts.find(contact => contact.id === params.canonicalContactId)
    : undefined;
  const canonicalContactNames = contactNames(canonicalContact);

  const candidate = extractMentionOnlyContactCandidate({
    fact: params.fact,
    canonicalContactName: params.canonicalContactName,
    canonicalContactNames,
    companionName: params.companionName,
  });
  if (!candidate) return undefined;

  const existing = findExistingMentionOnlyContact(contacts, candidate);
  const channelMemories = await params.memoryStore.getMemoriesByChannel(params.channelId, 50);

  if (existing) {
    if (
      typeof params.contactStore.updateRelationshipType === 'function'
      && shouldPromoteRelationship(existing.relationshipType, candidate.relationshipType)
    ) {
      await params.contactStore.updateRelationshipType(
        existing.id,
        candidate.relationshipType,
        'system:memory_extraction:mention_contact',
      );
    }
    await relinkRecurringMemories({
      memoryStore: params.memoryStore,
      candidate,
      contactId: existing.id,
      canonicalContactId: params.canonicalContactId,
      channelMemories,
      canonicalContactName: params.canonicalContactName,
      canonicalContactNames,
      companionName: params.companionName,
    });
    return existing;
  }

  const priorMentions = channelMemories.filter(memory => candidateMatchesMemory(memory, candidate, {
    canonicalContactName: params.canonicalContactName,
    canonicalContactNames,
    companionName: params.companionName,
  }));
  if (priorMentions.length + 1 < 2) {
    return undefined;
  }

  const created = await params.contactStore.upsert(
    {
      displayName: candidate.name,
      relationshipType: candidate.relationshipType,
    },
    {
      actor: 'system:memory_extraction:mention_contact',
    },
  );

  await relinkRecurringMemories({
    memoryStore: params.memoryStore,
    candidate,
    contactId: created.id,
    canonicalContactId: params.canonicalContactId,
    channelMemories,
    canonicalContactName: params.canonicalContactName,
    canonicalContactNames,
    companionName: params.companionName,
  });

  return created;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the relational fact is stated as a bond between the interlocutor and
 * the companion themselves — the deliberate signal the interlocutor ratchet
 * requires. This is what distinguishes "you're my best friend" (a bond with the
 * companion) from generic relational chatter like "enjoys time with friends".
 *
 * Accepts the fact when EITHER:
 *  - the companion is named in the fact (guard #5 in
 *    resolveInterlocutorRelationshipRatchet already guarantees no OTHER named
 *    third party carries the relationship, so a naming reference means the
 *    relation is ascribed involving the companion); OR
 *  - a second-person address ("you're my best friend") or first-person
 *    possessive claim ("my best friend, you") ties a relationship keyword to the
 *    companion.
 */
function factStatesInterlocutorBond(
  fact: ExtractedFact,
  companionName: string | undefined,
): boolean {
  const lowerText = fact.text.toLowerCase();

  const normalizedCompanion = companionName ? normalizeNameKey(companionName) : '';
  const companionNamePresent = normalizedCompanion.length > 0
    && new RegExp(`(^| )${escapeRegExp(normalizedCompanion)}( |$)`, 'u')
      .test(normalizeNameKey(fact.text));
  if (companionNamePresent) return true;

  if (!SECOND_PERSON_COMPANION_REFERENCE.test(lowerText)) return false;
  return SECOND_PERSON_BOND.test(lowerText) || FIRST_PERSON_POSSESSIVE_BOND.test(lowerText);
}

export interface InterlocutorRelationshipRatchetParams {
  fact: ExtractedFact;
  /** The contact the relational fact is attributed to (the conversation partner). */
  interlocutorContactId: string;
  contactStore: Pick<ContactStorePort, 'getById' | 'updateRelationshipType'> | null;
  canonicalContactName?: string;
  companionName?: string;
}

/**
 * Deliberate interlocutor relationship progression path (psfn-framework-kada.1).
 *
 * The mention-only path (resolveMentionOnlyContactForFact) structurally excludes
 * the canonical contact so third-party facts like "my brother Marcus" never
 * mis-target the speaker — a load-bearing exclusion that must stay. As a result
 * the person actually chatting with the companion was created as 'stranger' and
 * never progressed. This path fills that gap: relational evidence that is ABOUT
 * the interlocutor's own bond with the companion may ratchet their own
 * relationshipType upward, monotonic up only.
 *
 * The evidence bar is deliberately conservative. The ratchet fires only when ALL
 * hold:
 *  1. the fact is relational;
 *  2. inferRelationshipTypeFromFact yields a type (same keyword/tag inference
 *     quality as the mention path);
 *  3. that type is within INTERLOCUTOR_AUTO_RATCHET_TYPES (never family/partner/
 *     ai_companion from single weak evidence);
 *  4. (guard #5) the fact names NO third party — if the relationship keyword is
 *     attached to a named third party ("my brother Marcus"), we defer to the
 *     mention path and never touch the interlocutor;
 *  5. (guard #6) the fact states a bond with the companion themselves
 *     (factStatesInterlocutorBond);
 *  6. the new type strictly outranks the current one.
 *
 * Uses a distinct actor string so the audit trail separates it from the mention
 * path. The primary-contact guard (a primary contact may only become 'partner')
 * is enforced inside ContactStore.updateRelationshipType / the Postgres adapter,
 * so a primary interlocutor is simply a no-op here — never fought.
 */
export async function resolveInterlocutorRelationshipRatchet(
  params: InterlocutorRelationshipRatchetParams,
): Promise<RelationshipType | undefined> {
  const { contactStore } = params;
  if (!contactStore) return undefined;
  if (
    typeof contactStore.getById !== 'function'
    || typeof contactStore.updateRelationshipType !== 'function'
  ) {
    return undefined;
  }
  if (params.fact.type !== 'relational') return undefined;

  const inferred = inferRelationshipTypeFromFact(params.fact);
  if (!inferred) return undefined;
  if (!INTERLOCUTOR_AUTO_RATCHET_TYPES.has(inferred)) return undefined;

  const contact = await contactStore.getById(params.interlocutorContactId);
  if (!contact) return undefined;

  // Guard #5 — load-bearing third-party exclusion. Reuse the mention-only
  // candidate extractor with the interlocutor's OWN names (display + nickname)
  // and the companion name excluded. If it still finds a named candidate, the
  // relationship keyword belongs to a third party, so this path must not act.
  const thirdPartyCandidate = extractMentionOnlyContactCandidate({
    fact: params.fact,
    canonicalContactName: params.canonicalContactName,
    canonicalContactNames: contactNames(contact),
    companionName: params.companionName,
  });
  if (thirdPartyCandidate) return undefined;

  // Guard #6 — the evidence must be about the interlocutor's own bond with the
  // companion, not generic relational chatter.
  if (!factStatesInterlocutorBond(params.fact, params.companionName)) return undefined;

  if (!shouldPromoteRelationship(contact.relationshipType, inferred)) return undefined;

  const updated = await contactStore.updateRelationshipType(
    contact.id,
    inferred,
    'system:memory_extraction:interlocutor',
  );
  return updated ? inferred : undefined;
}

export const __test = {
  extractMentionOnlyContactCandidate,
  factStatesInterlocutorBond,
};
