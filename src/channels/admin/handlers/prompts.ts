import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import {
  CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
  isCanonicalCharacterFoundationLayer,
} from '../../../identity/canonical-foundation.js';
import type { PromptLayerMetadataUpdate } from '../../../identity/prompt-store.js';
import { PROMPT_LAYER_ROLES, type PromptLayerRole } from '../../../identity/prompt-types.js';
import {
  containsStructuredPromptSections,
  getMalformedStructuredPromptErrors,
  parseStructuredPromptForm,
} from '../prompt-structured-content.js';
import * as tpl from '../templates.js';

export class AdminPromptsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private injectPromptEditSystemNote(note: string): void {
    const legacy = this.legacy as any;
    const targetChannels = [...new Set(
      legacy.sessionStore
        .listChannels()
        .map((channel: any) => channel.channelId)
        .filter((channelId: string) => !channelId.startsWith('internal:') && !channelId.startsWith('shard:')),
    )];

    for (const channelId of targetChannels) {
      legacy.sessionManager.appendSystemNote(channelId, note);
    }
  }

  private resolvePromptLayerContent(params: URLSearchParams): { content: string } | { error: string } {
    if (containsStructuredPromptSections(params)) {
      const structured = parseStructuredPromptForm(params);
      if (!structured.ok) return { error: structured.error };
      return { content: structured.content };
    }

    const content = params.get('content') ?? '';
    const malformedStructuredErrors = getMalformedStructuredPromptErrors(content);
    if (malformedStructuredErrors.length > 0) {
      return { error: `Malformed structured prompt content: ${malformedStructuredErrors.join(' ')}` };
    }

    return { content };
  }

  private resolvePromptLayerMetadata(
    params: URLSearchParams,
  ): { metadata: PromptLayerMetadataUpdate } | { error: string } {
    const metadata: PromptLayerMetadataUpdate = {};

    if (params.has('identifier')) {
      const rawIdentifier = params.get('identifier');
      metadata.identifier = rawIdentifier?.trim() ? rawIdentifier.trim() : undefined;
    }

    if (params.has('role')) {
      const rawRole = params.get('role');
      const role = rawRole?.trim() ?? '';
      if (role.length === 0) {
        metadata.role = undefined;
      } else if (!PROMPT_LAYER_ROLES.includes(role as PromptLayerRole)) {
        return { error: `role must be one of: ${PROMPT_LAYER_ROLES.join(', ')}` };
      } else {
        metadata.role = role as PromptLayerRole;
      }
    }

    if (params.has('promptOrder')) {
      const rawPromptOrder = params.get('promptOrder');
      const value = rawPromptOrder?.trim() ?? '';
      if (value.length === 0) {
        metadata.promptOrder = undefined;
      } else if (!/^\d+$/.test(value)) {
        return { error: 'promptOrder must be an integer >= 0' };
      } else {
        metadata.promptOrder = parseInt(value, 10);
      }
    }

    return { metadata };
  }

  promptsPage(): string {
    const legacy = this.legacy as any;
    const layers = legacy.promptStore?.getAll() ?? [];
    const prompts = legacy.promptRegistry?.list() ?? [];
    return tpl.layout('Prompt Soil', tpl.promptsPage(layers, prompts), 'prompts');
  }

  promptDetail(layerId: string): string | null {
    const legacy = this.legacy as any;
    if (!legacy.promptStore) return null;
    const layer = legacy.promptStore.getById(layerId);
    if (!layer) return null;
    const history = legacy.promptStore.getLayerHistory(layerId);
    return tpl.layout(
      `${layer.name} -- Prompt Soil`,
      tpl.promptDetailPage(layer, history),
      'prompts',
    );
  }

  promptRegistryDetail(key: string): string | null {
    const legacy = this.legacy as any;
    if (!legacy.promptRegistry) return null;
    const prompt = legacy.promptRegistry.getByKey(key);
    if (!prompt) return null;
    const history = legacy.promptRegistry.getPromptHistory(key);
    return tpl.layout(
      `${prompt.key} -- Prompt Registry`,
      tpl.promptRegistryDetailPage(prompt, history),
      'prompts',
    );
  }

  updatePromptLayer(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptStore) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt layer edit was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const layer = legacy.promptStore.getById(layerId);
    if (!layer) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt layer edit was denied: prompt layer not found.',
        [`layerId=${layerId}`],
      );
      return '<div class="form-error">Prompt layer not found</div>';
    }
    if (isCanonicalCharacterFoundationLayer(layer)) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${CARD_BACKED_FOUNDATION_PROMPT_MESSAGE}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
    }
    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolved.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolved.error);
    }
    const resolvedMetadata = this.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolvedMetadata.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolvedMetadata.error);
    }
    try {
      const updatedLayer = legacy.promptStore.update(
        layerId,
        resolved.content,
        'admin',
        resolvedMetadata.metadata,
        'Admin prompt-layer edit via Garden UI',
      );
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone edited ${updatedLayer.type} prompt layer "${updatedLayer.name}".`,
        [`layerId=${updatedLayer.id}`, `version=${updatedLayer.version}`],
      );
      this.injectPromptEditSystemNote(
        `Admin updated ${updatedLayer.type} prompt layer "${updatedLayer.name}" (v${updatedLayer.version}).`,
      );
      return tpl.settingsFormResult(true, `Updated "${updatedLayer.name}" to v${updatedLayer.version}`);
    } catch (err) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  updatePromptRegistry(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptRegistry) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt registry edit was denied: prompt registry is not configured.',
      );
      return '<div class="form-error">Prompt registry not configured</div>';
    }
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const content = params.get('content') ?? '';
    try {
      const prompt = legacy.promptRegistry.update(key, content, 'admin');
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone edited static prompt "${prompt.key}".`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Updated "${prompt.key}" to v${prompt.version}`);
    } catch (err) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt registry edit failed: ${String(err)}`,
        [`key=${key}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  togglePromptLayer(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptStore) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt toggle was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const layer = legacy.promptStore.getById(layerId);
    if (!layer) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt toggle was denied: prompt layer not found.',
        [`layerId=${layerId}`],
      );
      return '<div class="form-error">Prompt layer not found</div>';
    }
    if (isCanonicalCharacterFoundationLayer(layer)) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt toggle was denied: ${CARD_BACKED_FOUNDATION_PROMPT_MESSAGE}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
    }
    try {
      legacy.promptStore.toggle(layerId);
      const updatedLayer = legacy.promptStore.getById(layerId);
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone toggled prompt layer "${updatedLayer?.name ?? layerId}".`,
        [updatedLayer ? `enabled=${updatedLayer.enabled}` : null],
      );
      if (updatedLayer) {
        this.injectPromptEditSystemNote(
          `Admin toggled ${updatedLayer.type} prompt layer "${updatedLayer.name}" (${updatedLayer.enabled ? 'enabled' : 'disabled'}).`,
        );
      }
      const layers = legacy.promptStore.getAll();
      return tpl.promptLayersFragment(layers);
    } catch (err) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt toggle failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptLayer(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptStore) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt rollback was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    const layer = legacy.promptStore.getById(layerId);
    if (!layer) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt rollback was denied: prompt layer not found.',
        [`layerId=${layerId}`, `version=${version}`],
      );
      return '<div class="form-error">Prompt layer not found</div>';
    }
    if (isCanonicalCharacterFoundationLayer(layer)) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt rollback was denied: ${CARD_BACKED_FOUNDATION_PROMPT_MESSAGE}`,
        [`layerId=${layerId}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
    }
    try {
      const updatedLayer = legacy.promptStore.rollback(layerId, version);
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone rolled prompt layer "${updatedLayer.name}" back to v${version}.`,
        [`layerId=${updatedLayer.id}`, `version=${updatedLayer.version}`],
      );
      this.injectPromptEditSystemNote(
        `Admin rolled back ${updatedLayer.type} prompt layer "${updatedLayer.name}" using v${version} content (now v${updatedLayer.version}).`,
      );
      return tpl.settingsFormResult(true, `Rolled back "${updatedLayer.name}" to content from v${version}`);
    } catch (err) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt rollback failed: ${String(err)}`,
        [`layerId=${layerId}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptRegistry(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptRegistry) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Static prompt rollback was denied: prompt registry is not configured.',
      );
      return '<div class="form-error">Prompt registry not configured</div>';
    }
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const prompt = legacy.promptRegistry.rollback(key, version);
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `Purrsephone rolled static prompt "${prompt.key}" back to v${version}.`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Rolled back "${prompt.key}" to content from v${version}`);
    } catch (err) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Static prompt rollback failed: ${String(err)}`,
        [`key=${key}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  previewPromptLayerDiff(body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) return tpl.settingsFormResult(false, resolved.error);
    const layer = legacy.promptStore.getById(layerId);
    if (!layer) return '<div class="form-error">Prompt layer not found</div>';
    return tpl.promptDiffFragment(layer.content, resolved.content);
  }
}
