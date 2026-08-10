import type { TurnID } from '../../../shared/contracts/runtime.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact, PurrMemory } from '../types.js';
import type {
  AcceptedFactWrite,
  ConcernCandidateExtractionSink,
  ExtractionTriggerReason,
} from './types.js';

export interface ExtractionSideEffectsInput {
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId: string | undefined;
  turnId: TurnID | undefined;
  sourceRef: string;
  recentEntries: SessionEntry[];
  existingMemories: readonly Pick<
    PurrMemory,
    'id' | 'type' | 'text' | 'importance' | 'confidence' | 'salience' | 'sourceRef'
  >[];
  acceptedFactsForConcernCandidates: ExtractedFact[];
  acceptedWrites: AcceptedFactWrite[];
  acceptedFactsByContact: Map<string | undefined, ExtractedFact[]>;
  emitConcernCandidates: ConcernCandidateExtractionSink | undefined;
  maybePersistEmotionalState: (
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ) => Promise<string | undefined>;
  maybeRefreshRecentContactShape: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ) => Promise<void>;
  assertEffectAllowed: (() => Promise<void>) | undefined;
}

export interface ExtractionSideEffectsResult {
  concernIds: string[];
  contactIds: string[];
}

export async function runExtractionSideEffects(
  input: ExtractionSideEffectsInput,
): Promise<ExtractionSideEffectsResult> {
  const { canonicalContactId, turnId, recentEntries } = input;
  const concernIds: string[] = [];
  if (input.emitConcernCandidates) {
    await input.assertEffectAllowed?.();
    const emittedConcernIds = await input.emitConcernCandidates({
      channelId: input.channelId,
      triggerReason: input.triggerReason,
      ...(canonicalContactId ? { canonicalContactId } : {}),
      ...(turnId ? { turnId } : {}),
      sourceRef: input.sourceRef,
      recentEntries,
      acceptedFacts: input.acceptedFactsForConcernCandidates,
      acceptedWrites: input.acceptedWrites,
      relatedMemories: input.existingMemories.map(memory => ({
        id: memory.id,
        type: memory.type,
        text: memory.text,
        importance: memory.importance,
        confidence: memory.confidence,
        salience: memory.salience,
        sourceRef: memory.sourceRef,
      })),
    });
    concernIds.push(...(emittedConcernIds ?? []));
  }
  const contactIds: string[] = [];
  const emotionalFactGroups = input.acceptedFactsByContact.size > 0
    ? input.acceptedFactsByContact
    : new Map<string | undefined, ExtractedFact[]>([[canonicalContactId, []]]);
  for (const [sourceContactId, acceptedFacts] of emotionalFactGroups.entries()) {
    await input.assertEffectAllowed?.();
    // Awaited (not fire-and-forget) so this durable child settles before the
    // parent effect receipt is applied and its fence releases (u5bv.6 AC3).
    const mutatedContactId = await input.maybePersistEmotionalState(
      sourceContactId,
      acceptedFacts,
      recentEntries,
    );
    if (mutatedContactId) contactIds.push(mutatedContactId);
  }

  const refreshGroups = groupAcceptedWritesByContact(input.acceptedWrites, canonicalContactId);
  for (const [contactId, writes] of refreshGroups.entries()) {
    await input.assertEffectAllowed?.();
    // Awaited for the same reason: no detached durable child may outlive the
    // parent receipt. The profile write is an idempotent upsert by contact id.
    await input.maybeRefreshRecentContactShape(
      input.channelId,
      input.triggerReason,
      contactId,
      writes,
    );
  }
  return { concernIds, contactIds };
}

export function groupAcceptedWritesByContact(
  writes: readonly AcceptedFactWrite[],
  fallbackContactId: string | undefined,
): Map<string | undefined, AcceptedFactWrite[]> {
  const groups = new Map<string | undefined, AcceptedFactWrite[]>();
  if (writes.length === 0) {
    groups.set(fallbackContactId, []);
    return groups;
  }

  for (const write of writes) {
    const contactIds = resolveProfileRefreshContactIds(write, fallbackContactId);
    for (const contactId of contactIds) {
      const profileWrite = write.contactId === contactId
        ? write
        : { ...write, contactId };
      const existing = groups.get(contactId);
      if (existing) {
        existing.push(profileWrite);
        continue;
      }
      groups.set(contactId, [profileWrite]);
    }
  }
  return groups;
}

export function resolveProfileRefreshContactIds(
  write: AcceptedFactWrite,
  fallbackContactId: string | undefined,
): string[] {
  const contactIds = new Set<string>();
  if (write.contactId) contactIds.add(write.contactId);
  if (write.subjectContactId) contactIds.add(write.subjectContactId);
  if (contactIds.size === 0 && !write.scopeRef && fallbackContactId) {
    contactIds.add(fallbackContactId);
  }
  return [...contactIds];
}
