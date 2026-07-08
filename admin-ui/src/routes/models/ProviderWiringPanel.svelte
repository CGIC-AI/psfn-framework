<script lang="ts">
  import type {
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
  } from '$lib/types';
  import {
    PROVIDER_TYPE_LABELS,
    PROVIDER_TYPES,
    providerIsEnabled,
    providerSupportsModelsApi,
  } from '$lib/providers/registry';
  import {
    providerRuntimeRole,
    providerTypeSummary,
    type ProviderEditableField,
  } from '$lib/providers/editor';

  let {
    settingsHref,
    providerRegistry,
    enabledProviderCount,
    providerValidationErrors,
    saving,
    providerDirty,
    addProviderEntry,
    removeProviderEntry,
    updateProviderEntry,
    setProviderType,
    setProviderField,
    saveProviderRegistry,
    discardProviderRegistryChanges,
  } = $props<{
    settingsHref: string;
    providerRegistry: CanonicalProviderRegistry;
    enabledProviderCount: number;
    providerValidationErrors: string[];
    saving: boolean;
    providerDirty: boolean;
    addProviderEntry: () => void;
    removeProviderEntry: (index: number) => void;
    updateProviderEntry: (
      index: number,
      updater: (entry: ProviderRegistryEntry) => ProviderRegistryEntry,
    ) => void;
    setProviderType: (index: number, value: string) => void;
    setProviderField: (index: number, field: ProviderEditableField, value: string) => void;
    saveProviderRegistry: () => void | Promise<void>;
    discardProviderRegistryChanges: () => void;
  }>();

  function providerTypeLabel(type: string): string {
    return PROVIDER_TYPE_LABELS[type as keyof typeof PROVIDER_TYPE_LABELS] ?? type;
  }
</script>

<div class="card-garden p-4 space-y-3">
  <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
    <div>
      <h2 class="text-sm font-serif font-semibold text-shadow-800">Provider Wiring</h2>
      <p class="text-sm text-shadow-600">Models target canonical provider ids from <span class="font-mono">providers.json</span>. Manage LiteLLM, OpenRouter, and direct provider endpoints here instead of hunting through Settings.</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-sm text-shadow-700">
        {enabledProviderCount} enabled / {providerRegistry.providers.length} total
      </span>
      <a
        href={settingsHref}
        class="inline-flex items-center rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors"
      >
        Open Settings Mirror
      </a>
      <button
        onclick={addProviderEntry}
        type="button"
        class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
      >
        Add Provider
      </button>
    </div>
  </div>
  {#if providerValidationErrors.length > 0}
    <div class="rounded-2xl border border-wilt-300 bg-wilt-50/60 p-4 space-y-2">
      <h3 class="text-sm font-medium text-wilt-700">Provider validation</h3>
      <ul class="space-y-1 text-sm text-wilt-700">
        {#each providerValidationErrors as issue}
          <li>{issue}</li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="space-y-4">
    {#each providerRegistry.providers as entry, index (entry.id)}
      <article class="rounded-2xl border border-bark-300 bg-white/90 p-4 space-y-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full border px-2.5 py-1 text-xs font-medium {providerIsEnabled(entry) ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-bark-300 bg-bark-100 text-shadow-600'}">
                {providerIsEnabled(entry) ? 'enabled' : 'disabled'}
              </span>
              <span class="rounded-full border border-bark-300 bg-bark-100 px-2.5 py-1 text-xs font-medium text-shadow-700">
                {providerTypeLabel(entry.type)}
              </span>
              {#each providerRuntimeRole(entry) as role}
                <span class="rounded-full border border-gold-300 bg-gold-50 px-2.5 py-1 text-xs text-gold-800">{role}</span>
              {/each}
            </div>
            <p class="text-sm text-shadow-600">{providerTypeSummary(entry.type)}</p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label class="inline-flex items-center gap-2 text-sm text-shadow-700">
              <input
                type="checkbox"
                checked={providerIsEnabled(entry)}
                onchange={(event) => updateProviderEntry(index, (nextEntry: ProviderRegistryEntry) => ({
                  ...nextEntry,
                  enabled: (event.currentTarget as HTMLInputElement).checked,
                }))}
                class="rounded border-bark-300 text-gold-600 focus:ring-gold-500"
              />
              Enabled
            </label>
            <button
              onclick={() => removeProviderEntry(index)}
              type="button"
              class="inline-flex items-center rounded-lg border border-wilt-300 px-3 py-1.5 text-sm font-medium text-wilt-600 hover:bg-wilt-50 transition-colors"
            >
              Remove
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div>
            <label for={`provider-id-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Provider Id</label>
            <input
              id={`provider-id-${index}`}
              type="text"
              value={entry.id}
              oninput={(event) => setProviderField(index, 'id', (event.currentTarget as HTMLInputElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
              placeholder="openrouter"
            />
          </div>
          <div>
            <label for={`provider-type-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Provider Type</label>
            <select
              id={`provider-type-${index}`}
              value={entry.type}
              onchange={(event) => setProviderType(index, (event.currentTarget as HTMLSelectElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
            >
              {#each PROVIDER_TYPES as type}
                <option value={type}>{PROVIDER_TYPE_LABELS[type]}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for={`provider-label-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Label</label>
            <input
              id={`provider-label-${index}`}
              type="text"
              value={entry.label ?? ''}
              oninput={(event) => setProviderField(index, 'label', (event.currentTarget as HTMLInputElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
              placeholder="LiteLLM primary"
            />
          </div>
          <div>
            <label for={`provider-api-base-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">API Base URL</label>
            <input
              id={`provider-api-base-${index}`}
              type="text"
              value={entry.apiBaseUrl ?? ''}
              oninput={(event) => setProviderField(index, 'apiBaseUrl', (event.currentTarget as HTMLInputElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
              placeholder="https://..."
            />
          </div>
          <div>
            <label for={`provider-models-api-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Models API URL</label>
            <input
              id={`provider-models-api-${index}`}
              type="text"
              value={entry.modelsApiUrl ?? ''}
              oninput={(event) => setProviderField(index, 'modelsApiUrl', (event.currentTarget as HTMLInputElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none disabled:bg-bark-100"
              placeholder={providerSupportsModelsApi(entry.type) ? 'https://.../models' : 'Only used for LiteLLM/OpenRouter catalogs'}
              disabled={!providerSupportsModelsApi(entry.type)}
            />
          </div>
          <div>
            <label for={`provider-api-key-env-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">API Key Ref</label>
            <input
              id={`provider-api-key-env-${index}`}
              type="text"
              value={entry.apiKeyRef?.kind === 'env' ? entry.apiKeyRef.envName : ''}
              oninput={(event) => setProviderField(index, 'apiKeyRef', (event.currentTarget as HTMLInputElement).value)}
              class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
              placeholder="LITELLM_API_KEY"
            />
          </div>
        </div>
      </article>
    {/each}
  </div>
  {#if providerRegistry.providers.length === 0}
    <div class="rounded-2xl border border-dashed border-bark-300 bg-bark-50/60 p-5 text-sm text-shadow-600">
      No providers configured yet. Add LiteLLM, OpenRouter, or direct backend providers here before wiring models.
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-3 pt-1">
    <button
      onclick={saveProviderRegistry}
      disabled={saving || !providerDirty}
      class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
    >
      {saving ? 'Saving...' : 'Save providers.json'}
    </button>
    <button
      onclick={discardProviderRegistryChanges}
      disabled={!providerDirty || saving}
      class="px-4 py-2 rounded-lg border border-bark-300 bg-white text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50 transition-colors"
    >
      Discard
    </button>
    {#if providerDirty}
      <span class="text-sm text-shadow-500">Provider changes are saved separately from models.json and take effect through canonical provider ids.</span>
    {/if}
  </div>
</div>
