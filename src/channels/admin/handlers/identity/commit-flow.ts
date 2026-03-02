import { randomUUID } from 'node:crypto';
import type { ContactStore } from '../../../../contacts/store.js';
import type { CharacterCardVersionStore } from '../../../../identity/card-versioning.js';
import { writeNormalizedCharacterCard } from '../../../../identity/importer.js';
import type { CharacterCardV2 } from '../../../../identity/types.js';
import type { EmbeddingService } from '../../../../agent/contracts.js';
import type { MemoryStore } from '../../../../memory/store.js';
import { normalizeProvenanceRefs, uniqueLowercase } from '../../utils.js';
import type { SessionStore } from '../../../../session/store.js';
import type { SubstrateConfig } from '../../../../types.js';
import { toErrorMessage } from '../../../../utils/errors.js';
import { applyRelationshipUpdate } from './memory-mutations.js';
import { recomputeStagedIntakeStatus } from './review-state.js';
import type { StagedIdentityIntake } from './intake-stage.js';

export interface ApplyStagedIdentityCommitParams {
  stage: StagedIdentityIntake;
  applyCard: boolean;
  selectedChatChunkIds: ReadonlySet<string>;
  selectedMemoryItemIds: ReadonlySet<string>;
  reason: string;
  config: SubstrateConfig;
  cardVersionStore: CharacterCardVersionStore | null;
  characterCard: CharacterCardV2;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  embeddingService: EmbeddingService | null;
  contactStore: ContactStore | null;
}

export interface ApplyStagedIdentityCommitResult {
  characterCard: CharacterCardV2;
  committedCard: boolean;
  committedChatChunks: number;
  committedChatMessages: number;
  committedMemoryItems: number;
  committedRelationshipUpdates: number;
  failedCard: boolean;
  failedChatChunks: number;
  failedMemoryItems: number;
}

export async function applyStagedIdentityCommit(
  params: ApplyStagedIdentityCommitParams,
): Promise<ApplyStagedIdentityCommitResult> {
  const {
    stage,
    applyCard,
    selectedChatChunkIds,
    selectedMemoryItemIds,
    reason,
    config,
    cardVersionStore,
    sessionStore,
    memoryStore,
    embeddingService,
    contactStore,
  } = params;
  let { characterCard } = params;

  let committedCard = false;
  let committedChatChunks = 0;
  let committedChatMessages = 0;
  let committedMemoryItems = 0;
  let committedRelationshipUpdates = 0;
  let failedCard = false;
  let failedChatChunks = 0;
  let failedMemoryItems = 0;

  if (applyCard && stage.cardMutation && stage.cardMutation.status === 'pending') {
    try {
      const destinationPath = config.characterCardPath?.trim();
      if (cardVersionStore) {
        const updated = cardVersionStore.update(
          stage.cardMutation.importedCard,
          'admin:intake',
          reason || `Committed staged intake bundle ${stage.id}`,
        );
        characterCard = updated.card;
      } else {
        if (destinationPath) {
          writeNormalizedCharacterCard(destinationPath, stage.cardMutation.importedCard);
        }
        characterCard = stage.cardMutation.importedCard;
      }
      stage.cardMutation.status = 'committed';
      committedCard = true;
    } catch {
      stage.cardMutation.status = 'failed';
      failedCard = true;
    }
  }

  if (stage.chatMutation) {
    for (const chunk of stage.chatMutation.chunks) {
      if (chunk.status !== 'pending' || !selectedChatChunkIds.has(chunk.id)) continue;
      try {
        const rows = stage.chatMutation.messages.slice(chunk.startMessage - 1, chunk.endMessage);
        for (const message of rows) {
          sessionStore.append({
            channelId: stage.chatMutation.channelId,
            role: message.role,
            content: message.content,
            authorId: message.authorId,
            authorName: message.authorName,
            timestamp: message.timestamp,
            metadata: JSON.stringify({
              type: 'admin_staged_intake',
              stageId: stage.id,
              chunkId: chunk.id,
            }),
          });
        }
        chunk.status = 'committed';
        committedChatChunks += 1;
        committedChatMessages += rows.length;
      } catch (error) {
        chunk.status = 'failed';
        chunk.error = toErrorMessage(error);
        failedChatChunks += 1;
      }
    }
  }

  for (const item of stage.memoryMutations) {
    if (item.status !== 'pending' || !selectedMemoryItemIds.has(item.id)) continue;
    try {
      if (item.mergeDecision === 'merge' && item.mergeTargetId) {
        const existing = memoryStore.getById(item.mergeTargetId);
        if (!existing) {
          throw new Error(`merge target "${item.mergeTargetId}" was not found`);
        }
        const mergedSalience = Math.max(existing.salience, item.salience);
        const mergedTags = uniqueLowercase([...existing.tags, ...item.tags]);
        const mergedProvenanceRefs = normalizeProvenanceRefs(
          [...(existing.provenanceRefs ?? []), existing.sourceRef, ...(item.provenanceRefs ?? [])],
        );
        memoryStore.updateMemory(existing.id, {
          salience: mergedSalience,
          tags: mergedTags,
          provenanceRefs: mergedProvenanceRefs,
          contactId: existing.contactId ?? item.contactId,
          lastAccessed: Date.now(),
          accessCount: existing.accessCount + 1,
        });
        item.proposedSalience = mergedSalience;
        item.provenanceRefs = mergedProvenanceRefs;
      } else {
        if (!embeddingService) {
          throw new Error('Embedding service is not configured for new memory writes');
        }
        const embedding = await embeddingService.embed(item.text);
        const now = Date.now();
        const sourceRef = item.provenanceRefs?.[0]
          ?? `admin:intake:${stage.id}:${item.source}`;
        memoryStore.insertMemory({
          id: `intake-${randomUUID()}`,
          text: item.text,
          type: item.type,
          importance: item.importance,
          confidence: 0.82,
          emotionalValence: 0,
          salience: item.salience,
          sourceRef,
          extractedAt: item.extractedAt ?? now,
          lastAccessed: item.lastAccessed ?? item.extractedAt ?? now,
          accessCount: 1,
          tags: item.tags,
          provenanceRefs: normalizeProvenanceRefs(item.provenanceRefs ?? [], sourceRef),
          sensitivity: item.sensitivity,
          contactId: item.contactId,
        }, embedding);
      }
      const relationshipApplied = applyRelationshipUpdate(
        contactStore,
        item.contactId,
        item.relationshipTypeHint,
      );
      item.relationshipUpdateApplied = relationshipApplied;
      if (relationshipApplied) committedRelationshipUpdates += 1;
      item.status = 'committed';
      item.error = undefined;
      committedMemoryItems += 1;
    } catch (error) {
      item.status = 'failed';
      item.error = toErrorMessage(error);
      failedMemoryItems += 1;
    }
  }

  recomputeStagedIntakeStatus(stage);
  return {
    characterCard,
    committedCard,
    committedChatChunks,
    committedChatMessages,
    committedMemoryItems,
    committedRelationshipUpdates,
    failedCard,
    failedChatChunks,
    failedMemoryItems,
  };
}
