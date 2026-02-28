import type { CharacterCardVersionStore } from '../../../identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import { extractCardPatchFromRecord } from '../../../identity/card-versioning.js';
import {
  normalizeImportedCard,
  writeNormalizedCharacterCard,
} from '../../../identity/importer.js';
import type { CCv3Data } from '@character-foundry/character-foundry/loader';
import type {
  AdminIdentityData,
  AdminIdentityService,
  DiffPreviewResult,
  FieldUpdateResult,
  ImportResult,
  IntakeCommitResult,
  IntakeStageResult,
  RollbackResult,
} from './types.js';

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractSettingsResultMessage(html: string): ImportResult {
  const successMatch = html.match(/<span class="form-success">([\s\S]*?)<\/span>/i);
  if (successMatch) {
    return {
      ok: true,
      message: decodeHtmlEntities(successMatch[1].trim()),
    };
  }

  const errorMatch = html.match(/<span class="form-error">([\s\S]*?)<\/span>/i);
  if (errorMatch) {
    return {
      ok: false,
      message: decodeHtmlEntities(errorMatch[1].trim()),
    };
  }

  return {
    ok: false,
    message: 'Identity import failed',
  };
}

export class AdminIdentityDataService implements AdminIdentityService {
  constructor(private readonly deps: {
    characterCard: CharacterCardV2;
    config: SubstrateConfig;
    cardVersionStore?: CharacterCardVersionStore | null;
    importIdentityCardHtml?: (body: string) => Promise<string>;
  }) {}

  getIdentityData(): AdminIdentityData {
    const snapshot = this.deps.cardVersionStore?.getCurrent();
    const history = this.deps.cardVersionStore?.getHistory() ?? [];
    const card = snapshot?.card ?? this.deps.characterCard;

    return {
      card,
      config: this.deps.config,
      version: snapshot?.version ?? 1,
      checksum: snapshot?.checksum,
      history,
      intakeReview: null,
    };
  }

  async importIdentityCard(body: string): Promise<ImportResult> {
    let payload: { path?: string; cardData?: unknown };
    try {
      payload = JSON.parse(body) as { path?: string; cardData?: unknown };
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    // Direct card data upload (from file upload endpoint)
    if (payload.cardData !== undefined) {
      return this.importCardFromData(payload.cardData);
    }

    // Path-based import (legacy)
    const importPath = payload.path?.trim();
    if (!importPath) {
      return { ok: false, message: 'path is required' };
    }

    if (!this.deps.importIdentityCardHtml) {
      return { ok: false, message: 'Identity import service is unavailable' };
    }

    const formBody = new URLSearchParams({ path: importPath }).toString();
    const html = await this.deps.importIdentityCardHtml(formBody);
    return extractSettingsResultMessage(html);
  }

  private importCardFromData(cardData: unknown): ImportResult {
    if (!cardData || typeof cardData !== 'object') {
      return { ok: false, message: 'Uploaded card data must be a JSON object' };
    }

    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return { ok: false, message: 'Card versioning store is not configured' };
    }

    try {
      // The uploaded data might be a full CharacterCardV2 (with spec/data) or a CCv3Data-shaped object.
      // Try to detect the shape and normalize accordingly.
      const record = cardData as Record<string, unknown>;

      let normalizedCard: CharacterCardV2;

      if (record.data && typeof record.data === 'object') {
        // Looks like a V2/V3 card with a data wrapper
        const dataRecord = record.data as Record<string, unknown>;
        normalizedCard = normalizeImportedCard({
          data: {
            name: typeof dataRecord.name === 'string' ? dataRecord.name : '',
            description: typeof dataRecord.description === 'string' ? dataRecord.description : '',
            personality: typeof dataRecord.personality === 'string' ? dataRecord.personality : '',
            scenario: typeof dataRecord.scenario === 'string' ? dataRecord.scenario : '',
            first_mes: typeof dataRecord.first_mes === 'string' ? dataRecord.first_mes : '',
            mes_example: typeof dataRecord.mes_example === 'string' ? dataRecord.mes_example : '',
            system_prompt: typeof dataRecord.system_prompt === 'string' ? dataRecord.system_prompt : '',
            post_history_instructions: typeof dataRecord.post_history_instructions === 'string' ? dataRecord.post_history_instructions : '',
            tags: Array.isArray(dataRecord.tags) ? dataRecord.tags : [],
            creator: typeof dataRecord.creator === 'string' ? dataRecord.creator : '',
            creator_notes: typeof dataRecord.creator_notes === 'string' ? dataRecord.creator_notes : '',
            character_book: dataRecord.character_book as CCv3Data['data']['character_book'],
          },
        } as CCv3Data);
      } else if (typeof record.name === 'string') {
        // Flat card data (no data wrapper)
        normalizedCard = normalizeImportedCard({
          data: {
            name: typeof record.name === 'string' ? record.name : '',
            description: typeof record.description === 'string' ? record.description : '',
            personality: typeof record.personality === 'string' ? record.personality : '',
            scenario: typeof record.scenario === 'string' ? record.scenario : '',
            first_mes: typeof record.first_mes === 'string' ? record.first_mes : '',
            mes_example: typeof record.mes_example === 'string' ? record.mes_example : '',
            system_prompt: typeof record.system_prompt === 'string' ? record.system_prompt : '',
            post_history_instructions: typeof record.post_history_instructions === 'string' ? record.post_history_instructions : '',
            tags: Array.isArray(record.tags) ? record.tags : [],
            creator: typeof record.creator === 'string' ? record.creator : '',
            creator_notes: typeof record.creator_notes === 'string' ? record.creator_notes : '',
            character_book: record.character_book as CCv3Data['data']['character_book'],
          },
        } as CCv3Data);
      } else {
        return { ok: false, message: 'Uploaded card data must have a "data" object or a "name" field' };
      }

      // Apply to version store
      const patch = extractCardPatchFromRecord(normalizedCard.data as unknown as Record<string, unknown>);
      const snapshot = cardVersionStore.updateData(patch, 'admin:upload', 'File upload import');

      // Also persist to disk if a card path is configured
      if (this.deps.config.characterCardPath) {
        writeNormalizedCharacterCard(this.deps.config.characterCardPath, snapshot.card);
      }

      // Update in-memory reference
      Object.assign(this.deps.characterCard, snapshot.card);

      return {
        ok: true,
        message: `Imported "${normalizedCard.data.name}" as v${snapshot.version}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  stageIdentityIntake(_body: string): IntakeStageResult {
    return {
      ok: false,
      message: 'Identity intake staging is not supported via JSON API yet',
    };
  }

  async commitIdentityIntake(_body: string): Promise<IntakeCommitResult> {
    return {
      ok: false,
      message: 'Identity intake commit is not supported via JSON API yet',
    };
  }

  rollbackIdentityCard(body: string): RollbackResult {
    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return { ok: false, message: 'Card versioning store is not configured' };
    }

    let payload: { version?: number };
    try {
      payload = JSON.parse(body) as { version?: number };
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const version = Number(payload.version);
    if (!Number.isInteger(version) || version <= 0) {
      return { ok: false, message: 'version must be a positive integer' };
    }

    try {
      const snapshot = cardVersionStore.rollback(version, 'admin:api');
      return {
        ok: true,
        message: `Rolled back to version ${version}`,
        snapshot,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  previewIdentityCardDiff(body: string): DiffPreviewResult {
    let payload: { version?: number };
    try {
      payload = JSON.parse(body) as { version?: number };
    } catch {
      return {
        ok: false,
        current: this.deps.characterCard,
        target: this.deps.characterCard,
      };
    }

    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return {
        ok: false,
        current: this.deps.characterCard,
        target: this.deps.characterCard,
      };
    }

    const version = Number(payload.version);
    const entry = Number.isInteger(version) ? cardVersionStore.getHistoryEntry(version) : undefined;
    const current = cardVersionStore.getCurrent()?.card ?? this.deps.characterCard;
    return {
      ok: Boolean(entry),
      current,
      target: entry?.newCard ?? current,
    };
  }

  updateIdentityField(body: string): FieldUpdateResult {
    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return { ok: false, message: 'Card versioning store is not configured' };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const field = typeof payload.field === 'string' ? payload.field.trim() : '';
    const value = typeof payload.value === 'string' ? payload.value : '';

    if (!field) {
      return { ok: false, message: 'field is required' };
    }

    const patch = extractCardPatchFromRecord({ [field]: value });
    try {
      const snapshot = cardVersionStore.updateData(patch, 'admin:api', `Admin edited field: ${field}`);
      // Also update the in-memory character card reference
      const current = snapshot.card;
      Object.assign(this.deps.characterCard, current);
      return { ok: true, message: `Updated "${field}" to v${snapshot.version}` };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }
}
