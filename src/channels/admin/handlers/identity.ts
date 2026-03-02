import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MemoryStore } from '../../../memory/store.js';
import { MemoryWriter, type MemoryWriteOptions } from '../../../memory/writer.js';
import type { SessionStore } from '../../../session/store.js';
import type { EmbeddingService } from '../../../agent/contracts.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { CharacterCardVersionStore } from '../../../identity/card-versioning.js';
import {
  importCharacterCardFromPath,
  persistExtractedCharacterAssets,
  writeNormalizedCharacterCard,
  type CharacterMemorySeed,
} from '../../../identity/importer.js';
import type { RelationshipType } from '../../../contacts/types.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';
import type {
  IdentityIntakeChatChunk,
  IdentityIntakeCardMutation,
  IdentityIntakeFlash,
  IdentityIntakeItemStatus,
  IdentityIntakeMemoryItem,
  IdentityIntakeReviewState,
  IdentityIntakeSourceSummary,
} from '../templates/identity.js';
import * as tpl from '../templates.js';
import { toErrorMessage } from '../../../utils/errors.js';
import {
  buildMemoryDedupKey,
  normalizeCardFieldValue,
  normalizeProvenanceRefs,
  parsePositiveInteger,
  shouldPromoteRelationship,
  truncateDebugText,
  uniqueLowercase,
} from '../utils.js';
import {
  chunkChatMessages,
  DEFAULT_CHAT_CHUNK_TARGET_TOKENS,
  MAX_CHAT_CHUNK_TARGET_TOKENS,
  MIN_CHAT_CHUNK_TARGET_TOKENS,
  parseChatMessagesFromPayload,
  parseJsonFileFromPath,
  parseLorebookItemsFromPayload,
  parseMemoryItemsFromPayload,
  type ParsedRawMemoryItem,
  type StagedIntakeChatMessage,
} from './identity/intake-parsing.js';

export interface AdminIdentityHandlersDeps {
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  embeddingService: EmbeddingService | null;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  contactStore?: ContactStore | null;
  cardVersionStore?: CharacterCardVersionStore | null;
  appendAuditTimelineEntry: (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
  ) => void;
}

const INTAKE_CARD_DIFF_FIELDS: Array<{ key: keyof CharacterCardV2['data']; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'first_mes', label: 'First Message' },
  { key: 'mes_example', label: 'Message Example' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History Instructions' },
  { key: 'tags', label: 'Tags' },
  { key: 'creator', label: 'Creator' },
  { key: 'creator_notes', label: 'Creator Notes' },
];

type IntakeStageStatus = 'pending' | 'partially_committed' | 'committed' | 'rejected';

interface StagedIntakeSource {
  kind: IdentityIntakeSourceSummary['kind'];
  path: string;
  itemCount: number;
  note?: string;
}

interface StagedIntakeCardMutation {
  sourcePath: string;
  containerFormat: string;
  spec: string;
  warnings: string[];
  status: IdentityIntakeItemStatus;
  rows: IdentityIntakeCardMutation['rows'];
  importedCard: CharacterCardV2;
}

interface StagedIntakeChatMutation {
  channelId: string;
  chunkTargetTokens: number;
  messages: StagedIntakeChatMessage[];
  chunks: IdentityIntakeChatChunk[];
}

interface StagedIntakeMemoryMutation extends Omit<IdentityIntakeMemoryItem, 'textPreview'> {
  text: string;
}

interface StagedIdentityIntake {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: IntakeStageStatus;
  sources: StagedIntakeSource[];
  cardMutation: StagedIntakeCardMutation | null;
  chatMutation: StagedIntakeChatMutation | null;
  memoryMutations: StagedIntakeMemoryMutation[];
}

interface IntakeFlash {
  kind: IdentityIntakeFlash['kind'];
  message: string;
}

export class AdminIdentityHandlers {
  private readonly memoryStore: MemoryStore;
  private readonly sessionStore: SessionStore;
  private readonly embeddingService: EmbeddingService | null;
  private readonly importMemoryWriter: MemoryWriter | null;
  private characterCard: CharacterCardV2;
  private readonly config: SubstrateConfig;
  private readonly contactStore: ContactStore | null;
  private readonly cardVersionStore: CharacterCardVersionStore | null;
  private readonly appendAuditTimelineEntryDelegate: (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
  ) => void;
  private stagedIntake: StagedIdentityIntake | null = null;

  constructor(deps: AdminIdentityHandlersDeps) {
    this.memoryStore = deps.memoryStore;
    this.sessionStore = deps.sessionStore;
    this.embeddingService = deps.embeddingService;
    this.importMemoryWriter = this.embeddingService
      ? new MemoryWriter(this.memoryStore, this.embeddingService)
      : null;
    this.characterCard = deps.characterCard;
    this.config = deps.config;
    this.contactStore = deps.contactStore ?? null;
    this.cardVersionStore = deps.cardVersionStore ?? null;
    this.appendAuditTimelineEntryDelegate = deps.appendAuditTimelineEntry;
  }

  identityPage(): string {
    const snapshot = this.cardVersionStore?.getCurrent();
    const history = this.cardVersionStore?.getHistory() ?? [];
    const card = snapshot?.card ?? this.characterCard;

    return tpl.layout(
      'Identity',
      tpl.identityPage(card, this.config, {
        version: snapshot?.version ?? 1,
        checksum: snapshot?.checksum,
        history,
        intakeReview: this.buildIdentityIntakeReviewState(),
      }),
      'identity',
    );
  }

  stageIdentityIntake(body: string): string {
    const params = new URLSearchParams(body);
    const cardPath = (params.get('cardPath') ?? '').trim();
    const chatPath = (params.get('chatPath') ?? '').trim();
    const lorebookPath = (params.get('lorebookPath') ?? '').trim();
    const memoryPath = (params.get('memoryPath') ?? '').trim();

    if (!cardPath && !chatPath && !lorebookPath && !memoryPath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Staged intake was denied: no source paths were provided.',
      );
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'Provide at least one source path to stage.',
      });
    }

    try {
      const now = Date.now();
      const stage: StagedIdentityIntake = {
        id: `intake-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        sources: [],
        cardMutation: null,
        chatMutation: null,
        memoryMutations: [],
      };

      if (cardPath) {
        const imported = importCharacterCardFromPath(cardPath);
        const rows = INTAKE_CARD_DIFF_FIELDS.map(({ key, label }) => {
          const previous = normalizeCardFieldValue(this.characterCard, key);
          const next = normalizeCardFieldValue(imported.card, key);
          return {
            field: label,
            previous,
            next,
            changed: previous !== next,
          };
        });
        stage.cardMutation = {
          sourcePath: imported.sourcePath,
          containerFormat: imported.containerFormat,
          spec: imported.spec,
          warnings: imported.warnings,
          status: 'pending',
          rows,
          importedCard: imported.card,
        };
        stage.sources.push({
          kind: 'card',
          path: imported.sourcePath,
          itemCount: 1,
          note: imported.warnings.length > 0 ? imported.warnings.join('; ') : undefined,
        });
      }

      if (chatPath) {
        const payload = parseJsonFileFromPath(chatPath, 'Chat');
        const messages = parseChatMessagesFromPayload(payload);
        if (messages.length === 0) {
          throw new Error(`Chat source "${chatPath}" produced no valid messages`);
        }
        const channelId = (params.get('chatChannelId') ?? '').trim() || `import:${stage.id}`;
        const chunkTargetTokens = parsePositiveInteger(
          params.get('chatChunkTargetTokens'),
          DEFAULT_CHAT_CHUNK_TARGET_TOKENS,
          MIN_CHAT_CHUNK_TARGET_TOKENS,
          MAX_CHAT_CHUNK_TARGET_TOKENS,
        );
        const chunks = chunkChatMessages(messages, chunkTargetTokens);
        stage.chatMutation = {
          channelId,
          chunkTargetTokens,
          messages,
          chunks,
        };
        stage.sources.push({
          kind: 'chat',
          path: chatPath,
          itemCount: messages.length,
          note: `${chunks.length} chunks @ ~${chunkTargetTokens} tokens`,
        });
      }

      if (lorebookPath) {
        const payload = parseJsonFileFromPath(lorebookPath, 'Lorebook');
        const lorebookItems = parseLorebookItemsFromPayload(payload, lorebookPath);
        if (lorebookItems.length === 0) {
          throw new Error(`Lorebook source "${lorebookPath}" produced no valid entries`);
        }
        stage.memoryMutations.push(...this.stageMemoryMutations(lorebookItems, 'lorebook'));
        stage.sources.push({
          kind: 'lorebook',
          path: lorebookPath,
          itemCount: lorebookItems.length,
        });
      }

      if (memoryPath) {
        const payload = parseJsonFileFromPath(memoryPath, 'Memory');
        const memoryItems = parseMemoryItemsFromPayload(payload, memoryPath);
        if (memoryItems.length === 0) {
          throw new Error(`Memory source "${memoryPath}" produced no valid entries`);
        }
        stage.memoryMutations.push(...this.stageMemoryMutations(memoryItems, 'memory'));
        stage.sources.push({
          kind: 'memory',
          path: memoryPath,
          itemCount: memoryItems.length,
        });
      }

      if (!stage.cardMutation && !stage.chatMutation && stage.memoryMutations.length === 0) {
        throw new Error('No mutations were parsed from the provided intake sources');
      }

      this.stagedIntake = stage;
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone staged intake bundle ${stage.id} for operator review.`,
        [
          `sources=${stage.sources.map(source => source.kind).join(',')}`,
          stage.chatMutation ? `chatChunks=${stage.chatMutation.chunks.length}` : null,
          stage.memoryMutations.length > 0 ? `memoryItems=${stage.memoryMutations.length}` : null,
        ],
      );
      return this.renderIdentityIntakeReview({
        kind: 'success',
        message: `Staged intake bundle ${stage.id}. Review proposed changes, then approve/reject/commit selected.`,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Staged intake failed: ${message}`,
      );
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Staging failed: ${message}`,
      });
    }
  }

  async commitIdentityIntake(body: string): Promise<string> {
    if (!this.stagedIntake) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'No staged intake bundle is available.',
      });
    }

    const stage = this.stagedIntake;
    const params = new URLSearchParams(body);
    const stageId = (params.get('stageId') ?? '').trim();
    if (stageId && stageId !== stage.id) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Staged bundle changed. Active stage is ${stage.id}.`,
      });
    }

    const decision = (params.get('decision') ?? '').trim();
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'partial') {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Unknown review decision "${decision}".`,
      });
    }

    const reason = (params.get('reason') ?? '').trim();
    const pendingCard = stage.cardMutation?.status === 'pending';
    const pendingChatChunks = stage.chatMutation?.chunks.filter(chunk => chunk.status === 'pending') ?? [];
    const pendingMemoryItems = stage.memoryMutations.filter(item => item.status === 'pending');

    if (!pendingCard && pendingChatChunks.length === 0 && pendingMemoryItems.length === 0) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'No pending staged changes remain.',
      });
    }

    if (decision === 'reject') {
      if (stage.cardMutation?.status === 'pending') stage.cardMutation.status = 'rejected';
      for (const chunk of pendingChatChunks) chunk.status = 'rejected';
      for (const item of pendingMemoryItems) item.status = 'rejected';
      stage.status = 'rejected';
      stage.updatedAt = Date.now();

      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Operator rejected staged intake bundle ${stage.id}.`,
        [
          pendingCard ? 'card=rejected' : null,
          pendingChatChunks.length > 0 ? `chatChunksRejected=${pendingChatChunks.length}` : null,
          pendingMemoryItems.length > 0 ? `memoryItemsRejected=${pendingMemoryItems.length}` : null,
          reason ? `note=${reason}` : null,
        ],
      );
      return this.renderIdentityIntakeReview({
        kind: 'success',
        message: `Rejected pending changes for bundle ${stage.id}.`,
      });
    }

    const applyCard = decision === 'approve'
      ? pendingCard
      : (pendingCard && (params.get('applyCard') === 'true' || params.get('applyCard') === 'on'));
    const selectedChatChunkIds = decision === 'approve'
      ? new Set(pendingChatChunks.map(chunk => chunk.id))
      : new Set(
        params.getAll('chatChunkId')
          .map(value => value.trim())
          .filter(Boolean),
      );
    const selectedMemoryItemIds = decision === 'approve'
      ? new Set(pendingMemoryItems.map(item => item.id))
      : new Set(
        params.getAll('memoryItemId')
          .map(value => value.trim())
          .filter(Boolean),
      );

    if (!applyCard && selectedChatChunkIds.size === 0 && selectedMemoryItemIds.size === 0) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'Select at least one pending mutation to commit.',
      });
    }

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
        const destinationPath = this.config.characterCardPath?.trim();
        if (this.cardVersionStore) {
          const updated = this.cardVersionStore.update(
            stage.cardMutation.importedCard,
            'admin:intake',
            reason || `Committed staged intake bundle ${stage.id}`,
          );
          this.characterCard = updated.card;
        } else {
          if (destinationPath) {
            writeNormalizedCharacterCard(destinationPath, stage.cardMutation.importedCard);
          }
          this.characterCard = stage.cardMutation.importedCard;
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
            this.sessionStore.append({
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
          const existing = this.memoryStore.getById(item.mergeTargetId);
          if (!existing) {
            throw new Error(`merge target "${item.mergeTargetId}" was not found`);
          }
          const mergedSalience = Math.max(existing.salience, item.salience);
          const mergedTags = uniqueLowercase([...existing.tags, ...item.tags]);
          const mergedProvenanceRefs = normalizeProvenanceRefs(
            [...(existing.provenanceRefs ?? []), existing.sourceRef, ...(item.provenanceRefs ?? [])],
          );
          this.memoryStore.updateMemory(existing.id, {
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
          if (!this.embeddingService) {
            throw new Error('Embedding service is not configured for new memory writes');
          }
          const embedding = await this.embeddingService.embed(item.text);
          const now = Date.now();
          const sourceRef = item.provenanceRefs?.[0]
            ?? `admin:intake:${stage.id}:${item.source}`;
          this.memoryStore.insertMemory({
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
        const relationshipApplied = this.applyRelationshipUpdate(
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

    this.recomputeStagedIntakeStatus(stage);

    this.appendAuditTimelineEntry(
      'identity_edit',
      failedCard || failedChatChunks > 0 || failedMemoryItems > 0 ? 'denied' : 'allowed',
      `Operator applied "${decision}" decision to staged intake bundle ${stage.id}.`,
      [
        committedCard ? 'card=committed' : null,
        committedChatChunks > 0 ? `chatChunksCommitted=${committedChatChunks}` : null,
        committedChatMessages > 0 ? `chatMessagesCommitted=${committedChatMessages}` : null,
        committedMemoryItems > 0 ? `memoryItemsCommitted=${committedMemoryItems}` : null,
        committedRelationshipUpdates > 0 ? `relationshipUpdates=${committedRelationshipUpdates}` : null,
        failedCard ? 'card=failed' : null,
        failedChatChunks > 0 ? `chatChunksFailed=${failedChatChunks}` : null,
        failedMemoryItems > 0 ? `memoryItemsFailed=${failedMemoryItems}` : null,
        reason ? `note=${reason}` : null,
      ],
    );

    if (committedMemoryItems > 0 || failedMemoryItems > 0) {
      this.appendAuditTimelineEntry(
        'memory_mutation',
        failedMemoryItems > 0 ? 'denied' : 'allowed',
        failedMemoryItems > 0
          ? `Staged memory commit finished with failures for bundle ${stage.id}.`
          : `Staged memory commit completed for bundle ${stage.id}.`,
        [
          `committed=${committedMemoryItems}`,
          `failed=${failedMemoryItems}`,
        ],
      );
    }

    const summary: string[] = [];
    if (committedCard) summary.push('card committed');
    if (committedChatChunks > 0) summary.push(`${committedChatChunks} chat chunks committed`);
    if (committedMemoryItems > 0) summary.push(`${committedMemoryItems} memory items committed`);
    if (committedRelationshipUpdates > 0) summary.push(`${committedRelationshipUpdates} relationship updates applied`);
    if (failedCard) summary.push('card failed');
    if (failedChatChunks > 0) summary.push(`${failedChatChunks} chat chunks failed`);
    if (failedMemoryItems > 0) summary.push(`${failedMemoryItems} memory items failed`);
    if (summary.length === 0) summary.push('no pending items matched selection');

    return this.renderIdentityIntakeReview({
      kind: failedCard || failedChatChunks > 0 || failedMemoryItems > 0 ? 'error' : 'success',
      message: summary.join('; '),
    });
  }

  async importIdentityCard(body: string): Promise<string> {
    const params = new URLSearchParams(body);
    const sourcePath = (params.get('path') ?? '').trim();
    if (!sourcePath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity import was denied: source path was not provided.',
      );
      return tpl.identityImportResult(false, 'path is required');
    }

    const destinationPath = this.config.characterCardPath?.trim();
    if (!destinationPath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity import was denied: CHARACTER_CARD_PATH is not configured.',
      );
      return tpl.identityImportResult(false, 'CHARACTER_CARD_PATH is not configured');
    }

    try {
      const imported = importCharacterCardFromPath(sourcePath);
      if (this.cardVersionStore) {
        const updated = this.cardVersionStore.update(
          imported.card,
          'admin:import',
          `Imported from ${imported.sourcePath}`,
        );
        this.characterCard = updated.card;
      } else {
        writeNormalizedCharacterCard(destinationPath, imported.card);
        this.characterCard = imported.card;
      }

      const warnings = [...imported.warnings];

      let persistedAssetCount = 0;
      let assetRootDir: string | null = null;
      if (imported.assets.length > 0) {
        assetRootDir = this.resolveCharacterImportAssetRootDir();
        if (!assetRootDir) {
          warnings.push('Extracted media assets were not persisted because dataDir is not configured.');
        } else {
          try {
            persistExtractedCharacterAssets(imported.assets, assetRootDir);
            persistedAssetCount = imported.assets.length;
          } catch (error) {
            const message = toErrorMessage(error);
            warnings.push(`Extracted media assets were not persisted: ${message}`);
          }
        }
      }

      const memorySeedResult = await this.importCharacterBookSeeds(
        imported.memorySeeds,
        imported.sourcePath,
      );
      if (memorySeedResult.skippedReason) {
        warnings.push(`Character-book memory seeding skipped: ${memorySeedResult.skippedReason}`);
      } else if (memorySeedResult.errors > 0) {
        warnings.push(`Character-book memory seeding completed with ${memorySeedResult.errors} errors.`);
      }

      const summaryDetails: string[] = [];
      if (imported.memorySeeds.length > 0) {
        if (memorySeedResult.skippedReason) {
          summaryDetails.push(`parsed ${imported.memorySeeds.length} character-book seeds (write skipped)`);
        } else {
          summaryDetails.push(
            `character-book seeds: ${memorySeedResult.written} written, ${memorySeedResult.deduplicated} deduplicated`,
          );
        }
      }
      if (imported.assets.length > 0) {
        summaryDetails.push(
          persistedAssetCount > 0
            ? `persisted ${persistedAssetCount} media assets`
            : `extracted ${imported.assets.length} media assets (persistence skipped)`,
        );
      }

      const warningSuffix = warnings.length > 0
        ? ` Warnings: ${warnings.join('; ')}`
        : '';
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone imported an identity card from ${imported.sourcePath}.`,
        [
          `name=${imported.card.data.name}`,
          `format=${imported.containerFormat}`,
          `spec=${imported.spec}`,
          imported.memorySeeds.length > 0 ? `memorySeeds=${imported.memorySeeds.length}` : null,
          memorySeedResult.attempted > 0 && !memorySeedResult.skippedReason
            ? `memoryWrites=${memorySeedResult.written}/${memorySeedResult.deduplicated}/${memorySeedResult.errors}`
            : null,
          imported.assets.length > 0 ? `assets=${imported.assets.length}` : null,
          assetRootDir && persistedAssetCount > 0 ? `assetRoot=${assetRootDir}` : null,
        ],
      );
      return tpl.identityImportResult(
        true,
        `Imported "${imported.card.data.name}" from ${imported.sourcePath} (${imported.containerFormat}/${imported.spec}).`
          + `${summaryDetails.length > 0 ? ` ${summaryDetails.join('; ')}.` : ''}`
          + warningSuffix,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity import failed: ${message}`,
        [`source=${sourcePath}`],
      );
      return tpl.identityImportResult(false, `Import failed: ${message}`);
    }
  }

  rollbackIdentityCard(body: string): string {
    if (!this.cardVersionStore) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity rollback was denied: versioning is not configured.',
      );
      return tpl.identityCardVersionResult(false, 'Character card versioning is not configured.');
    }
    const params = new URLSearchParams(body);
    const rawVersion = params.get('version') ?? '';
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version <= 0) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity rollback was denied: invalid version "${rawVersion}".`,
      );
      return tpl.identityCardVersionResult(false, 'version must be a positive integer.');
    }

    try {
      const snapshot = this.cardVersionStore.rollback(version);
      this.characterCard = snapshot.card;
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone rolled identity back to version ${version}.`,
        [`currentVersion=${snapshot.version}`],
      );
      return tpl.identityCardVersionResult(
        true,
        `Rolled back to version ${version}. Current version is v${snapshot.version}.`,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity rollback failed: ${message}`,
        [`version=${version}`],
      );
      return tpl.identityCardVersionResult(false, message);
    }
  }

  previewIdentityCardDiff(body: string): string {
    if (!this.cardVersionStore) {
      return '<div class="form-error">Character card versioning is not configured.</div>';
    }
    const params = new URLSearchParams(body);
    const rawVersion = params.get('version') ?? '';
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version <= 0) {
      return '<div class="form-error">version must be a positive integer.</div>';
    }

    const entry = this.cardVersionStore.getHistoryEntry(version);
    if (!entry) {
      return `<div class="form-error">No history entry found for version ${version}.</div>`;
    }

    return tpl.identityCardDiffFragment(entry.previousCard, entry.newCard, {
      fromVersion: entry.version,
      toVersion: entry.version + 1,
      updatedBy: entry.updatedBy,
      timestamp: entry.timestamp,
      reason: entry.reason,
    });
  }

  private appendAuditTimelineEntry(
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
    actor?: AdminAuditActor,
  ): void {
    this.appendAuditTimelineEntryDelegate(actionType, decision, narrative, details, actor);
  }

  private buildIdentityIntakeReviewState(): IdentityIntakeReviewState | null {
    if (!this.stagedIntake) return null;
    const stage = this.stagedIntake;
    return {
      stageId: stage.id,
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      status: stage.status,
      sources: stage.sources,
      cardMutation: stage.cardMutation
        ? {
          sourcePath: stage.cardMutation.sourcePath,
          containerFormat: stage.cardMutation.containerFormat,
          spec: stage.cardMutation.spec,
          warnings: stage.cardMutation.warnings,
          status: stage.cardMutation.status,
          rows: stage.cardMutation.rows,
        }
        : undefined,
      chatProposal: stage.chatMutation
        ? {
          channelId: stage.chatMutation.channelId,
          totalMessages: stage.chatMutation.messages.length,
          chunkTargetTokens: stage.chatMutation.chunkTargetTokens,
          chunks: stage.chatMutation.chunks,
        }
        : undefined,
      memoryItems: stage.memoryMutations.map(item => ({
        id: item.id,
        source: item.source,
        textPreview: truncateDebugText(item.text, 220),
        type: item.type,
        importance: item.importance,
        salience: item.salience,
        criticality: item.criticality,
        mergeDecision: item.mergeDecision,
        mergeTargetId: item.mergeTargetId,
        existingSalience: item.existingSalience,
        proposedSalience: item.proposedSalience,
        provenanceRefs: item.provenanceRefs,
        relationshipTypeHint: item.relationshipTypeHint,
        relationshipUpdatePlanned: item.relationshipUpdatePlanned,
        relationshipUpdateApplied: item.relationshipUpdateApplied,
        status: item.status,
        error: item.error,
      })),
    };
  }

  private renderIdentityIntakeReview(flash?: IntakeFlash): string {
    return tpl.identityIntakeReviewFragment(this.buildIdentityIntakeReviewState(), flash);
  }

  private stageMemoryMutations(
    items: readonly ParsedRawMemoryItem[],
    source: 'lorebook' | 'memory',
  ): StagedIntakeMemoryMutation[] {
    const existingByText = new Map<string, ReturnType<MemoryStore['getAllActiveMemories']>[number]>();
    for (const memory of this.memoryStore.getAllActiveMemories()) {
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
      const relationshipUpdatePlanned = this.resolveRelationshipUpdatePlan(
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

  private resolveRelationshipUpdatePlan(
    contactId: string | undefined,
    candidate: RelationshipType | undefined,
  ): RelationshipType | undefined {
    if (!contactId || !candidate || !this.contactStore) return undefined;
    const contact = this.contactStore.getById(contactId);
    if (!contact) return undefined;
    if (!shouldPromoteRelationship(contact.relationshipType, candidate)) return undefined;
    return candidate;
  }

  private applyRelationshipUpdate(
    contactId: string | undefined,
    candidate: RelationshipType | undefined,
  ): RelationshipType | undefined {
    if (!contactId || !candidate || !this.contactStore) return undefined;
    const planned = this.resolveRelationshipUpdatePlan(contactId, candidate);
    if (!planned) return undefined;
    const updated = this.contactStore.updateRelationshipType(contactId, planned);
    return updated ? planned : undefined;
  }

  private recomputeStagedIntakeStatus(stage: StagedIdentityIntake): void {
    const statuses: IdentityIntakeItemStatus[] = [];
    if (stage.cardMutation) statuses.push(stage.cardMutation.status);
    if (stage.chatMutation) statuses.push(...stage.chatMutation.chunks.map(chunk => chunk.status));
    statuses.push(...stage.memoryMutations.map(item => item.status));

    const pending = statuses.filter(status => status === 'pending').length;
    const committed = statuses.filter(status => status === 'committed').length;
    const rejected = statuses.filter(status => status === 'rejected').length;
    const failed = statuses.filter(status => status === 'failed').length;

    if (pending === 0 && committed > 0 && rejected === 0 && failed === 0) {
      stage.status = 'committed';
    } else if (pending === 0 && committed === 0 && (rejected > 0 || failed > 0)) {
      stage.status = 'rejected';
    } else if (committed > 0 || rejected > 0 || failed > 0) {
      stage.status = 'partially_committed';
    } else {
      stage.status = 'pending';
    }
    stage.updatedAt = Date.now();
  }

  private resolveCharacterImportAssetRootDir(): string | null {
    const dataDir = this.config.dataDir?.trim();
    if (!dataDir) return null;
    return join(dataDir, 'identity-assets');
  }

  private buildCharacterBookSeedWrites(
    seeds: readonly CharacterMemorySeed[],
    sourcePath: string,
  ): MemoryWriteOptions[] {
    const sourceToken = encodeURIComponent(sourcePath);
    return seeds.map((seed, index) => ({
      text: seed.text,
      type: seed.type,
      importance: seed.importance,
      tags: uniqueLowercase(['character_import', ...seed.tags]),
      sourceRef: `admin:import:character_book:${sourceToken}:${index + 1}`,
      sensitivity: seed.sensitivity,
    }));
  }

  private async importCharacterBookSeeds(
    seeds: readonly CharacterMemorySeed[],
    sourcePath: string,
  ): Promise<{
    attempted: number;
    written: number;
    deduplicated: number;
    superseded: number;
    errors: number;
    skippedReason?: string;
  }> {
    if (seeds.length === 0) {
      return {
        attempted: 0,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
      };
    }

    if (!this.importMemoryWriter) {
      return {
        attempted: seeds.length,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
        skippedReason: 'memory writer is not configured',
      };
    }

    try {
      const result = await this.importMemoryWriter.importBatch(
        this.buildCharacterBookSeedWrites(seeds, sourcePath),
      );
      return {
        attempted: seeds.length,
        written: result.written,
        deduplicated: result.deduplicated,
        superseded: result.superseded,
        errors: result.errors,
      };
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        attempted: seeds.length,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
        skippedReason: message,
      };
    }
  }
}
