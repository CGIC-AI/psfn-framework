import { randomUUID } from 'node:crypto';
import type { ContactStore } from '../../../../contacts/store.js';
import { importCharacterCardFromPath } from '../../../../identity/importer.js';
import type { CharacterCardV2 } from '../../../../identity/types.js';
import type { MemoryStore } from '../../../../memory/store.js';
import { normalizeCardFieldValue, parsePositiveInteger } from '../../utils.js';
import {
  chunkChatMessages,
  DEFAULT_CHAT_CHUNK_TARGET_TOKENS,
  MAX_CHAT_CHUNK_TARGET_TOKENS,
  MIN_CHAT_CHUNK_TARGET_TOKENS,
  parseChatMessagesFromPayload,
  parseJsonFileFromPath,
  parseLorebookItemsFromPayload,
  parseMemoryItemsFromPayload,
} from './intake-parsing.js';
import { INTAKE_CARD_DIFF_FIELDS, type StagedIdentityIntake } from './intake-stage.js';
import { stageMemoryMutations } from './memory-mutations.js';

export interface BuildStagedIdentityIntakeParams {
  params: URLSearchParams;
  cardPath: string;
  chatPath: string;
  lorebookPath: string;
  memoryPath: string;
  characterCard: CharacterCardV2;
  memoryStore: MemoryStore;
  contactStore: ContactStore | null;
}

export function buildStagedIdentityIntake(options: BuildStagedIdentityIntakeParams): StagedIdentityIntake {
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

  if (options.cardPath) {
    const imported = importCharacterCardFromPath(options.cardPath);
    const rows = INTAKE_CARD_DIFF_FIELDS.map(({ key, label }) => {
      const previous = normalizeCardFieldValue(options.characterCard, key);
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

  if (options.chatPath) {
    const payload = parseJsonFileFromPath(options.chatPath, 'Chat');
    const messages = parseChatMessagesFromPayload(payload);
    if (messages.length === 0) {
      throw new Error(`Chat source "${options.chatPath}" produced no valid messages`);
    }
    const channelId = (options.params.get('chatChannelId') ?? '').trim() || `import:${stage.id}`;
    const chunkTargetTokens = parsePositiveInteger(
      options.params.get('chatChunkTargetTokens'),
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
      path: options.chatPath,
      itemCount: messages.length,
      note: `${chunks.length} chunks @ ~${chunkTargetTokens} tokens`,
    });
  }

  if (options.lorebookPath) {
    const payload = parseJsonFileFromPath(options.lorebookPath, 'Lorebook');
    const lorebookItems = parseLorebookItemsFromPayload(payload, options.lorebookPath);
    if (lorebookItems.length === 0) {
      throw new Error(`Lorebook source "${options.lorebookPath}" produced no valid entries`);
    }
    stage.memoryMutations.push(...stageMemoryMutations(
      options.memoryStore,
      options.contactStore,
      lorebookItems,
      'lorebook',
    ));
    stage.sources.push({
      kind: 'lorebook',
      path: options.lorebookPath,
      itemCount: lorebookItems.length,
    });
  }

  if (options.memoryPath) {
    const payload = parseJsonFileFromPath(options.memoryPath, 'Memory');
    const memoryItems = parseMemoryItemsFromPayload(payload, options.memoryPath);
    if (memoryItems.length === 0) {
      throw new Error(`Memory source "${options.memoryPath}" produced no valid entries`);
    }
    stage.memoryMutations.push(...stageMemoryMutations(
      options.memoryStore,
      options.contactStore,
      memoryItems,
      'memory',
    ));
    stage.sources.push({
      kind: 'memory',
      path: options.memoryPath,
      itemCount: memoryItems.length,
    });
  }

  if (!stage.cardMutation && !stage.chatMutation && stage.memoryMutations.length === 0) {
    throw new Error('No mutations were parsed from the provided intake sources');
  }

  return stage;
}
