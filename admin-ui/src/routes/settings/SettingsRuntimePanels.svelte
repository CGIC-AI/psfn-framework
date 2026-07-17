<script lang="ts">
  import { setContext } from 'svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import {
    SETTINGS_FIELD_ERRORS_CONTEXT,
    formatSettingOptionLabel,
    settingControlId,
    settingLabelId,
    type SettingsFieldErrorsAccessor,
  } from './settings-page-helpers';

  let {
    openSections,
    importRouteModeOptions,
    inputClass,
    labelClass,
    toggleClass,
    getSource,
    fieldErrors,
    toggleSection,
    retryMaxAttempts = $bindable(3),
    retryBaseDelayMs = $bindable(2000),
    importRouteMode = $bindable('background'),
    importStrictPolicy = $bindable(false),
    importLocalEndpointUrl = $bindable(''),
    importLocalModel = $bindable(''),
    openRouterProviderOrder = $bindable(''),
    webFetchAllowHttp = $bindable(false),
    webFetchDomainAllowlist = $bindable(''),
    webFetchAllowInternalNetwork = $bindable(false),
    webFetchTlsCaCertPaths = $bindable(''),
  } = $props<{
    openSections: Set<string>;
    importRouteModeOptions: string[];
    inputClass: string;
    labelClass: string;
    toggleClass: string;
    getSource: (key: string) => string;
    fieldErrors: SettingsFieldErrorsAccessor;
    toggleSection: (id: string) => void;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    importRouteMode: string;
    importStrictPolicy: boolean;
    importLocalEndpointUrl: string;
    importLocalModel: string;
    openRouterProviderOrder: string;
    webFetchAllowHttp: boolean;
    webFetchDomainAllowlist: string;
    webFetchAllowInternalNetwork: boolean;
    webFetchTlsCaCertPaths: string;
  }>();

  // Publish the validation-error accessor to descendant SettingFieldLabels so
  // curated controls render their field's errors inline (ybm3).
  setContext<SettingsFieldErrorsAccessor>(SETTINGS_FIELD_ERRORS_CONTEXT, (key) => fieldErrors(key));
</script>

<section
  id={settingsSimpleSectionAnchorId('runtime-llm')}
  data-settings-section="runtime-llm"
>
  <div class="card-garden overflow-hidden">
    <button
      onclick={() => toggleSection('llm')}
      class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
    >
      <div class="flex items-center gap-3">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">LLM Retries & Behavior</h2>
      </div>
      <div class="flex items-center gap-3">
        {#if !openSections.has('llm')}
          <span class="text-sm text-shadow-500">Retries: {retryMaxAttempts}, Delay: {retryBaseDelayMs}ms</span>
        {/if}
        <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('llm') ? 'rotate-180' : ''}">&#9660;</span>
      </div>
    </button>
    {#if openSections.has('llm')}
      <div class="px-5 pb-5 border-t border-bark-300 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel label="LLM Max Retries" keys="retryMaxAttempts" forId={settingControlId('retryMaxAttempts')} class={labelClass} />
            <input id={settingControlId('retryMaxAttempts')} type="number" min="0" max="10" bind:value={retryMaxAttempts} class={inputClass} />
            <p class="text-sm text-shadow-500 mt-1">Maximum retry attempts (0-10)</p>
          </div>
          <div>
            <SettingFieldLabel label="Retry Base Delay (ms)" keys="retryBaseDelayMs" forId={settingControlId('retryBaseDelayMs')} class={labelClass} />
            <input id={settingControlId('retryBaseDelayMs')} type="number" min="500" max="30000" step="100" bind:value={retryBaseDelayMs} class={inputClass} />
            <p class="text-sm text-shadow-500 mt-1">Base delay between retries (500-30,000ms)</p>
          </div>
        </div>
      </div>
    {/if}
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('runtime-import')}
  data-settings-section="runtime-import"
>
  <div class="card-garden overflow-hidden">
    <button
      onclick={() => toggleSection('import')}
      class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
    >
      <div class="flex items-center gap-3">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Import Processing</h2>
      </div>
      <div class="flex items-center gap-3">
        {#if !openSections.has('import')}
          <span class="text-sm text-shadow-500">Route: {importRouteMode}{importStrictPolicy ? ' (strict)' : ''}</span>
        {/if}
        <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('import') ? 'rotate-180' : ''}">&#9660;</span>
      </div>
    </button>
    {#if openSections.has('import')}
      <div class="px-5 pb-5 border-t border-bark-300 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel
              label="Route Mode"
              keys="importProcessingRouteMode"
              source={getSource('importProcessingRouteMode')}
              forId={settingControlId('importProcessingRouteMode')}
              class={labelClass}
            />
            <select id={settingControlId('importProcessingRouteMode')} bind:value={importRouteMode} class={inputClass}>
              {#each importRouteModeOptions as option}
                <option value={option}>{formatSettingOptionLabel('importProcessingRouteMode', option)}</option>
              {/each}
            </select>
          </div>
          <div>
            <SettingFieldLabel label="Strict Policy" keys="importProcessingStrictPolicy" labelId={settingLabelId('importProcessingStrictPolicy')} class={labelClass} />
            <label class="flex items-center gap-2 mt-2 cursor-pointer">
              <input id={settingControlId('importProcessingStrictPolicy')} aria-labelledby={settingLabelId('importProcessingStrictPolicy')} type="checkbox" bind:checked={importStrictPolicy} class={toggleClass} />
              <span class="text-sm text-shadow-700">Enforce strict ZDR compliance</span>
            </label>
          </div>
          <div>
            <SettingFieldLabel label="OpenRouter Provider Order" keys="openRouterProviderOrder" forId={settingControlId('openRouterProviderOrder')} class={labelClass} />
            <input id={settingControlId('openRouterProviderOrder')} type="text" bind:value={openRouterProviderOrder} class={inputClass} placeholder="comma-separated providers" />
            <p class="text-sm text-shadow-500 mt-1">Global/import fallback order for provider routing.</p>
          </div>
          <div>
            <SettingFieldLabel label="Local Endpoint URL" keys="importProcessingLocalEndpointUrl" forId={settingControlId('importProcessingLocalEndpointUrl')} class={labelClass} />
            <input id={settingControlId('importProcessingLocalEndpointUrl')} type="text" bind:value={importLocalEndpointUrl} class={inputClass} placeholder="http://localhost:8080" />
          </div>
          <div>
            <SettingFieldLabel label="Local Model" keys="importProcessingLocalModel" forId={settingControlId('importProcessingLocalModel')} class={labelClass} />
            <input id={settingControlId('importProcessingLocalModel')} type="text" bind:value={importLocalModel} class={inputClass} placeholder="model name" />
          </div>
        </div>
      </div>
    {/if}
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('runtime-fetch')}
  data-settings-section="runtime-fetch"
>
  <div class="card-garden overflow-hidden">
    <button
      onclick={() => toggleSection('fetch')}
      class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
    >
      <div class="flex items-center gap-3">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Web Fetch Policy</h2>
      </div>
      <div class="flex items-center gap-3">
        {#if !openSections.has('fetch')}
          <span class="text-sm text-shadow-500">{webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only'}{webFetchAllowInternalNetwork ? ', internal LAN' : ''}</span>
        {/if}
        <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('fetch') ? 'rotate-180' : ''}">&#9660;</span>
      </div>
    </button>
    {#if openSections.has('fetch')}
      <div class="px-5 pb-5 border-t border-bark-300 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel label="Allow Internal Network Access" keys="webFetchAllowInternalNetwork" labelId={settingLabelId('webFetchAllowInternalNetwork')} class={labelClass} />
            <label class="flex items-center gap-2 mt-2 cursor-pointer">
              <input id={settingControlId('webFetchAllowInternalNetwork')} aria-labelledby={settingLabelId('webFetchAllowInternalNetwork')} type="checkbox" bind:checked={webFetchAllowInternalNetwork} class={toggleClass} />
              <span class="text-sm text-shadow-700">Allow fetching from RFC1918 / LAN hosts (cloud metadata still blocked)</span>
            </label>
          </div>
          <div>
            <SettingFieldLabel label="Allow Non-HTTPS" keys="webFetchAllowHttp" labelId={settingLabelId('webFetchAllowHttp')} class={labelClass} />
            <label class="flex items-center gap-2 mt-2 cursor-pointer">
              <input id={settingControlId('webFetchAllowHttp')} aria-labelledby={settingLabelId('webFetchAllowHttp')} type="checkbox" bind:checked={webFetchAllowHttp} class={toggleClass} />
              <span class="text-sm text-shadow-700">Allow HTTP (non-encrypted) web fetch requests</span>
            </label>
          </div>
          <div>
            <SettingFieldLabel label="Domain Allowlist" keys="webFetchDomainAllowlist" forId={settingControlId('webFetchDomainAllowlist')} class={labelClass} />
            <input id={settingControlId('webFetchDomainAllowlist')} type="text" bind:value={webFetchDomainAllowlist} class={inputClass} placeholder="comma-separated domains (e.g. example.local, internal.corp)" />
          </div>
          <div>
            <SettingFieldLabel label="TLS CA Cert Paths" keys="webFetchTlsCaCertPaths" forId={settingControlId('webFetchTlsCaCertPaths')} class={labelClass} />
            <input id={settingControlId('webFetchTlsCaCertPaths')} type="text" bind:value={webFetchTlsCaCertPaths} class={inputClass} placeholder="comma-separated file paths" />
          </div>
        </div>
      </div>
    {/if}
  </div>
</section>
