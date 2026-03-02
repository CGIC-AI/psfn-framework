import * as tpl from '../templates.js';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminPromptsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private get adapter(): any {
    return this.legacy as any;
  }

  promptsPage(): string {
    const layers = this.adapter.promptStore?.getAll() ?? [];
    const prompts = this.adapter.promptRegistry?.list() ?? [];
    return tpl.layout('Prompt Soil', tpl.promptsPage(layers, prompts), 'prompts');
  }

  promptDetail(layerId: string): string | null {
    if (!this.adapter.promptStore) return null;
    const layer = this.adapter.promptStore.getById(layerId);
    if (!layer) return null;
    const history = this.adapter.promptStore.getLayerHistory(layerId);
    return tpl.layout(
      `${layer.name} -- Prompt Soil`,
      tpl.promptDetailPage(layer, history),
      'prompts',
    );
  }

  promptRegistryDetail(key: string): string | null {
    if (!this.adapter.promptRegistry) return null;
    const prompt = this.adapter.promptRegistry.getByKey(key);
    if (!prompt) return null;
    const history = this.adapter.promptRegistry.getPromptHistory(key);
    return tpl.layout(
      `${prompt.key} -- Prompt Registry`,
      tpl.promptRegistryDetailPage(prompt, history),
      'prompts',
    );
  }

  updatePromptLayer(body: string): string {
    if (!this.adapter.promptStore) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt layer edit was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const resolved = this.adapter.resolvePromptLayerContent(params);
    if ('error' in resolved) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolved.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolved.error);
    }
    const resolvedMetadata = this.adapter.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolvedMetadata.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolvedMetadata.error);
    }
    try {
      const layer = this.adapter.promptStore.update(
        layerId,
        resolved.content,
        'admin',
        resolvedMetadata.metadata,
        'Admin prompt-layer edit via Garden UI',
      );
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN edited ${layer.type} prompt layer "${layer.name}".`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );
      this.adapter.injectPromptEditSystemNote(
        `Admin updated ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      return tpl.settingsFormResult(true, `Updated "${layer.name}" to v${layer.version}`);
    } catch (err) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  updatePromptRegistry(body: string): string {
    if (!this.adapter.promptRegistry) {
      this.adapter.appendAuditTimelineEntry(
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
      const prompt = this.adapter.promptRegistry.update(key, content, 'admin');
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN edited static prompt "${prompt.key}".`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Updated "${prompt.key}" to v${prompt.version}`);
    } catch (err) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt registry edit failed: ${String(err)}`,
        [`key=${key}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  togglePromptLayer(body: string): string {
    if (!this.adapter.promptStore) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt toggle was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    try {
      this.adapter.promptStore.toggle(layerId);
      const layer = this.adapter.promptStore.getById(layerId);
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN toggled prompt layer "${layer?.name ?? layerId}".`,
        [layer ? `enabled=${layer.enabled}` : null],
      );
      if (layer) {
        this.adapter.injectPromptEditSystemNote(
          `Admin toggled ${layer.type} prompt layer "${layer.name}" (${layer.enabled ? 'enabled' : 'disabled'}).`,
        );
      }
      // Return the full updated list for htmx swap
      const layers = this.adapter.promptStore.getAll();
      return tpl.promptLayersFragment(layers);
    } catch (err) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt toggle failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptLayer(body: string): string {
    if (!this.adapter.promptStore) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt rollback was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const layer = this.adapter.promptStore.rollback(layerId, version);
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled prompt layer "${layer.name}" back to v${version}.`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );
      this.adapter.injectPromptEditSystemNote(
        `Admin rolled back ${layer.type} prompt layer "${layer.name}" using v${version} content (now v${layer.version}).`,
      );
      return tpl.settingsFormResult(true, `Rolled back "${layer.name}" to content from v${version}`);
    } catch (err) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt rollback failed: ${String(err)}`,
        [`layerId=${layerId}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptRegistry(body: string): string {
    if (!this.adapter.promptRegistry) {
      this.adapter.appendAuditTimelineEntry(
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
      const prompt = this.adapter.promptRegistry.rollback(key, version);
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled static prompt "${prompt.key}" back to v${version}.`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Rolled back "${prompt.key}" to content from v${version}`);
    } catch (err) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Static prompt rollback failed: ${String(err)}`,
        [`key=${key}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  previewPromptLayerDiff(body: string): string {
    if (!this.adapter.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const resolved = this.adapter.resolvePromptLayerContent(params);
    if ('error' in resolved) return tpl.settingsFormResult(false, resolved.error);
    const layer = this.adapter.promptStore.getById(layerId);
    if (!layer) return '<div class="form-error">Prompt layer not found</div>';
    return tpl.promptDiffFragment(layer.content, resolved.content);
  }
}
