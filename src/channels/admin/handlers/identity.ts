import type { MemoryStore } from '../../../memory/store.js';
import { MemoryWriter } from '../../../memory/writer.js';
import type { SessionStore } from '../../../session/store.js';
import type { EmbeddingService } from '../../../agent/contracts.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { CharacterCardVersionStore } from '../../../identity/card-versioning.js';
import type { PromptLayerStore } from '../../../identity/prompt-store.js';
import {
  importCharacterCardFromPath,
  writeNormalizedCharacterCard,
} from '../../../identity/importer.js';
import { syncCharacterFoundationPromptFromCard } from '../../../identity/prompt-sync.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';
import * as tpl from '../templates.js';
import { toErrorMessage } from '../../../utils/errors.js';
import { type IntakeFlash, type StagedIdentityIntake } from './identity/intake-stage.js';
import { buildIdentityIntakeReviewState } from './identity/review-state.js';
import {
  importCharacterBookSeeds,
  persistImportedAssets,
} from './identity/import-flow.js';
import { applyStagedIdentityCommit } from './identity/commit-flow.js';
import { buildStagedIdentityIntake } from './identity/stage-flow.js';

export interface AdminIdentityHandlersDeps {
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  embeddingService: EmbeddingService | null;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  contactStore?: ContactStore | null;
  cardVersionStore?: CharacterCardVersionStore | null;
  promptStore?: PromptLayerStore | null;
  appendAuditTimelineEntry: (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
  ) => void;
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
  private readonly promptStore: PromptLayerStore | null;
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
    this.promptStore = deps.promptStore ?? null;
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
        intakeReview: buildIdentityIntakeReviewState(this.stagedIntake),
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
      const stage = buildStagedIdentityIntake({
        params,
        cardPath,
        chatPath,
        lorebookPath,
        memoryPath,
        characterCard: this.characterCard,
        memoryStore: this.memoryStore,
        contactStore: this.contactStore,
      });

      this.stagedIntake = stage;
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN staged intake bundle ${stage.id} for operator review.`,
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

    const {
      characterCard,
      committedCard,
      committedChatChunks,
      committedChatMessages,
      committedMemoryItems,
      committedRelationshipUpdates,
      failedCard,
      failedChatChunks,
      failedMemoryItems,
    } = await applyStagedIdentityCommit({
      stage,
      applyCard,
      selectedChatChunkIds,
      selectedMemoryItemIds,
      reason,
      config: this.config,
      cardVersionStore: this.cardVersionStore,
      characterCard: this.characterCard,
      sessionStore: this.sessionStore,
      memoryStore: this.memoryStore,
      embeddingService: this.embeddingService,
      contactStore: this.contactStore,
    });
    this.characterCard = characterCard;

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
      const promptSync = syncCharacterFoundationPromptFromCard(
        this.promptStore,
        this.characterCard,
        'admin:import',
        `Sync Character Foundation prompt from imported card: ${imported.sourcePath}`,
      );
      if (!promptSync.ok) {
        warnings.push(`Character Foundation prompt sync failed: ${promptSync.error}`);
      }

      const {
        persistedAssetCount,
        assetRootDir,
        warnings: assetWarnings,
      } = persistImportedAssets(imported.assets, this.config);
      warnings.push(...assetWarnings);

      const memorySeedResult = await importCharacterBookSeeds(
        this.importMemoryWriter,
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
        `PSFN imported an identity card from ${imported.sourcePath}.`,
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
      const promptSync = syncCharacterFoundationPromptFromCard(
        this.promptStore,
        snapshot.card,
        'admin:rollback',
        `Sync Character Foundation prompt after rollback to version ${version}`,
      );
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled identity back to version ${version}.`,
        [
          `currentVersion=${snapshot.version}`,
          !promptSync.ok ? `promptSyncError=${promptSync.error}` : null,
        ],
      );
      return tpl.identityCardVersionResult(
        true,
        `Rolled back to version ${version}. Current version is v${snapshot.version}.`
          + (!promptSync.ok ? ` Warning: Character Foundation prompt sync failed (${promptSync.error}).` : ''),
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

  private renderIdentityIntakeReview(flash?: IntakeFlash): string {
    return tpl.identityIntakeReviewFragment(buildIdentityIntakeReviewState(this.stagedIntake), flash);
  }
}
