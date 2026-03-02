import type { ContactStore } from '../../../../contacts/store.js';
import type { RelationshipType } from '../../../../contacts/types.js';
import type { MemoryStore } from '../../../../memory/store.js';
import type { IdentityIntakeMemoryItem } from '../../templates/identity.js';
import { buildMemoryDedupKey, shouldPromoteRelationship } from '../../utils.js';
import type { ParsedRawMemoryItem } from './intake-parsing.js';
import type { StagedIntakeMemoryMutation } from './intake-stage.js';

export function stageMemoryMutations(
  memoryStore: MemoryStore,
  contactStore: ContactStore | null,
  items: readonly ParsedRawMemoryItem[],
  source: 'lorebook' | 'memory',
): StagedIntakeMemoryMutation[] {
  const existingByText = new Map<string, ReturnType<MemoryStore['getAllActiveMemories']>[number]>();
  for (const memory of memoryStore.getAllActiveMemories()) {
    const key = buildMemoryDedupKey(memory.text, memory.type, memory.contactId);
    if (!key) continue;
    const previous = existingByText.get(key);
    if (previous && previous.salience >= memory.salience) continue;
    existingByText.set(key, memory);
  }

  return items.map((item, index) => {
    const key = buildMemoryDedupKey(item.text, item.type, item.contactId);
    const existing = key ? existingByText.get(key) : undefined;
    const mergeDecision: IdentityIntakeMemoryItem['mergeDecision'] = existing ? 'merge' : 'create';
    const proposedSalience = existing ? Math.max(existing.salience, item.salience) : item.salience;
    const relationshipUpdatePlanned = resolveRelationshipUpdatePlan(
      contactStore,
      item.contactId,
      item.relationshipTypeHint,
    );
    return {
      id: `${source}-item-${index + 1}`,
      source,
      text: item.text,
      type: item.type,
      importance: item.importance,
      salience: item.salience,
      criticality: item.criticality,
      mergeDecision,
      mergeTargetId: existing?.id,
      existingSalience: existing?.salience,
      proposedSalience,
      status: 'pending',
      tags: item.tags,
      provenanceRefs: item.provenanceRefs,
      sensitivity: item.sensitivity,
      contactId: item.contactId,
      extractedAt: item.extractedAt,
      lastAccessed: item.lastAccessed,
      relationshipTypeHint: item.relationshipTypeHint,
      relationshipUpdatePlanned,
    };
  });
}

export function resolveRelationshipUpdatePlan(
  contactStore: ContactStore | null,
  contactId: string | undefined,
  candidate: RelationshipType | undefined,
): RelationshipType | undefined {
  if (!contactId || !candidate || !contactStore) return undefined;
  const contact = contactStore.getById(contactId);
  if (!contact) return undefined;
  if (!shouldPromoteRelationship(contact.relationshipType, candidate)) return undefined;
  return candidate;
}

export function applyRelationshipUpdate(
  contactStore: ContactStore | null,
  contactId: string | undefined,
  candidate: RelationshipType | undefined,
): RelationshipType | undefined {
  if (!contactId || !candidate || !contactStore) return undefined;
  const planned = resolveRelationshipUpdatePlan(contactStore, contactId, candidate);
  if (!planned) return undefined;
  const updated = contactStore.updateRelationshipType(contactId, planned);
  return updated ? planned : undefined;
}
