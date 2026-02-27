import type { CharacterCardVersionStore } from '../../../identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import { extractCardPatchFromRecord } from '../../../identity/card-versioning.js';
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
    let payload: { path?: string };
    try {
      payload = JSON.parse(body) as { path?: string };
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

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
      const snapshot = cardVersionStore.rollbackToVersion(version, 'admin:api');
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
    const entry = Number.isInteger(version) ? cardVersionStore.findVersion(version) : undefined;
    const current = cardVersionStore.getCurrent()?.card ?? this.deps.characterCard;
    return {
      ok: Boolean(entry),
      current,
      target: entry?.card ?? current,
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
