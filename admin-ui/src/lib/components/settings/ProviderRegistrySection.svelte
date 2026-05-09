<script lang="ts">
  import type {
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
  } from '$lib/types';
  import {
    PROVIDER_TYPE_LABELS,
    PROVIDER_TYPES,
    providerSupportsModelsApi,
  } from '$lib/providers/registry';
  import {
    providerRuntimeRole,
    providerTypeSummary,
    type ProviderEditableField,
  } from '$lib/providers/editor';
  import SettingFieldLabel from './SettingFieldLabel.svelte';

  let {
    modelsHref,
    providerRegistry,
    providerValidationErrors,
    saving,
    isDirty,
    inputClass,
    labelClass,
    toggleClass,
    providerCardClass,
    addProviderEntry,
    removeProviderEntry,
    updateProviderEntry,
    setProviderType,
    setProviderField,
    saveProviderRegistry,
    discardProviderRegistryChanges,
  } = $props<{
    modelsHref: string;
    providerRegistry: CanonicalProviderRegistry;
    providerValidationErrors: string[];
    saving: boolean;
    isDirty: boolean;
    inputClass: string;
    labelClass: string;
    toggleClass: string;
    providerCardClass: string;
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

  function enabledProviderCount(): number {
    return providerRegistry.providers.filter((entry: ProviderRegistryEntry) => entry.enabled).length;
  }

  function providerTypeLabel(type: string): string {
    return PROVIDER_TYPE_LABELS[type as keyof typeof PROVIDER_TYPE_LABELS] ?? type;
  }

  function setProviderEnabled(index: number, enabled: boolean): void {
    updateProviderEntry(index, (nextEntry: ProviderRegistryEntry) => ({
      ...nextEntry,
      enabled,
    }));
  }
</script>

<div class="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
  <div class="space-y-2">
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Providers</p>
    <h2 class="text-sm font-serif font-semibold text-shadow-800">Provider Registry and Backend Wiring</h2>
    <p class="text-sm text-shadow-600">
      Manage canonical provider ids, backend base URLs, and API key env wiring in <span class="font-mono">providers.json</span>.
      Models reference these ids directly.
    </p>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-sm text-shadow-700">
      {enabledProviderCount()} enabled / {providerRegistry.providers.length} total
    </span>
    <a
      href={modelsHref}
      class="inline-flex items-center rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors"
    >
      Open Models
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
    <article class={providerCardClass}>
      <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full border px-2.5 py-1 text-xs font-medium {entry.enabled ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-bark-300 bg-bark-100 text-shadow-600'}">
              {entry.enabled ? 'enabled' : 'disabled'}
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
              checked={entry.enabled}
              onchange={(event) => setProviderEnabled(index, (event.currentTarget as HTMLInputElement).checked)}
              class={toggleClass}
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
          <SettingFieldLabel label="Provider Id" keys="id" class={labelClass} />
          <input
            type="text"
            value={entry.id}
            oninput={(event) => setProviderField(index, 'id', (event.currentTarget as HTMLInputElement).value)}
            class={inputClass}
            placeholder="openrouter"
          />
          <p class="mt-1 text-sm text-shadow-500">Models and routing provider orders reference this id directly.</p>
        </div>
        <div>
          <SettingFieldLabel label="Provider Type" keys="type" class={labelClass} />
          <select
            value={entry.type}
            onchange={(event) => setProviderType(index, (event.currentTarget as HTMLSelectElement).value)}
            class={inputClass}
          >
            {#each PROVIDER_TYPES as type}
              <option value={type}>{providerTypeLabel(type)}</option>
            {/each}
          </select>
        </div>
        <div>
          <SettingFieldLabel label="Label" keys="label" class={labelClass} />
          <input
            type="text"
            value={entry.label ?? ''}
            oninput={(event) => setProviderField(index, 'label', (event.currentTarget as HTMLInputElement).value)}
            class={inputClass}
            placeholder="OpenRouter primary"
          />
        </div>
        <div>
          <SettingFieldLabel label="API Base URL" keys="apiBaseUrl" class={labelClass} />
          <input
            type="text"
            value={entry.apiBaseUrl ?? ''}
            oninput={(event) => setProviderField(index, 'apiBaseUrl', (event.currentTarget as HTMLInputElement).value)}
            class={inputClass}
            placeholder="https://..."
          />
        </div>
        <div>
          <SettingFieldLabel label="Models API URL" keys="modelsApiUrl" class={labelClass} />
          <input
            type="text"
            value={entry.modelsApiUrl ?? ''}
            oninput={(event) => setProviderField(index, 'modelsApiUrl', (event.currentTarget as HTMLInputElement).value)}
            class={inputClass}
            placeholder={providerSupportsModelsApi(entry.type) ? 'https://.../models' : 'Only used for OpenRouter'}
            disabled={!providerSupportsModelsApi(entry.type)}
          />
        </div>
        <div>
          <SettingFieldLabel label="API Key Ref" keys="apiKeyRef.envName" class={labelClass} />
          <input
            type="text"
            value={entry.apiKeyRef?.kind === 'env' ? entry.apiKeyRef.envName : ''}
            oninput={(event) => setProviderField(index, 'apiKeyRef', (event.currentTarget as HTMLInputElement).value)}
            class={inputClass}
            placeholder="OPENROUTER_API_KEY"
          />
        </div>
      </div>

      {#if entry.metadata && Object.keys(entry.metadata).length > 0}
        <div class="rounded-xl border border-bark-200 bg-bark-50 p-3">
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Metadata</p>
          <pre class="mt-2 overflow-x-auto text-xs text-shadow-700">{JSON.stringify(entry.metadata, null, 2)}</pre>
        </div>
      {/if}
    </article>
  {/each}
</div>

{#if providerRegistry.providers.length === 0}
  <div class="rounded-2xl border border-dashed border-bark-300 bg-bark-50/60 p-5 text-sm text-shadow-600">
    No providers configured yet. Add at least one provider before wiring models to backend endpoints.
  </div>
{/if}

<div class="flex flex-wrap items-center gap-3 pt-1">
  <button
    onclick={saveProviderRegistry}
    disabled={saving || !isDirty}
    class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
  >
    {saving ? 'Saving...' : 'Save providers.json'}
  </button>
  <button
    onclick={discardProviderRegistryChanges}
    disabled={!isDirty || saving}
    class="px-4 py-2 rounded-lg border border-bark-300 bg-white text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50 transition-colors"
  >
    Discard
  </button>
  {#if isDirty}
    <span class="text-sm text-shadow-500">Provider changes can be saved here immediately or along with the general settings save.</span>
  {/if}
</div>
