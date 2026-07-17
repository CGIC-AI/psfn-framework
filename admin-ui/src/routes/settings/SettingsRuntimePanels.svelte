<script lang="ts">
  import { setContext } from 'svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import SettingsCollapsibleSection from '$lib/components/settings/SettingsCollapsibleSection.svelte';
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
  <SettingsCollapsibleSection
    title="LLM Retries & Behavior"
    open={openSections.has('llm')}
    onToggle={() => toggleSection('llm')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">Retries: {retryMaxAttempts}, Delay: {retryBaseDelayMs}ms</span>
    {/snippet}
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
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('runtime-import')}
  data-settings-section="runtime-import"
>
  <SettingsCollapsibleSection
    title="Import Processing"
    open={openSections.has('import')}
    onToggle={() => toggleSection('import')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">Route: {importRouteMode}{importStrictPolicy ? ' (strict)' : ''}</span>
    {/snippet}
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
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('runtime-fetch')}
  data-settings-section="runtime-fetch"
>
  <SettingsCollapsibleSection
    title="Web Fetch Policy"
    open={openSections.has('fetch')}
    onToggle={() => toggleSection('fetch')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">{webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only'}{webFetchAllowInternalNetwork ? ', internal LAN' : ''}</span>
    {/snippet}
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
  </SettingsCollapsibleSection>
</section>
