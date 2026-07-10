<script lang="ts">
  import { base } from '$app/paths';
  import ProviderRegistrySection from '$lib/components/settings/ProviderRegistrySection.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import type {
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
  } from '$lib/types';
  import type { ProviderEditableField } from '$lib/providers/editor';

  let {
    providerRegistry,
    providerValidationErrors,
    providerRegistryDirty,
    saving,
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
    providerRegistry: CanonicalProviderRegistry;
    providerValidationErrors: string[];
    providerRegistryDirty: () => boolean;
    saving: boolean;
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
</script>

<section
  id={settingsSimpleSectionAnchorId('models')}
  class="card-garden p-5 space-y-3"
  data-settings-section="models"
>
  <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Models</p>
  <h2 class="text-sm font-serif font-semibold text-shadow-800">Model Registry and Purpose Routing</h2>
  <p class="text-sm text-shadow-600">
    Purpose-tagged primary/fallback models, model rosters, and context windows are managed in the dedicated Models workspace.
  </p>
  <a
    href={`${base}/models`}
    class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
  >
    Open Models
  </a>
</section>

<section
  id={settingsSimpleSectionAnchorId('prompting')}
  class="card-garden p-5 space-y-3"
  data-settings-section="prompting"
>
  <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Prompting</p>
  <h2 class="text-sm font-serif font-semibold text-shadow-800">Prompt Stack and Authoring</h2>
  <p class="text-sm text-shadow-600">
    Prompt layers and authoring controls live in Prompts. Prompt assembly debugging lives in Prompt Monitor.
  </p>
  <div class="flex flex-wrap gap-2">
    <a
      href={`${base}/prompts`}
      class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
    >
      Open Prompts
    </a>
    <a
      href={`${base}/prompt-monitor`}
      class="inline-flex items-center rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors"
    >
      Open Prompt Monitor
    </a>
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('providers')}
  class="card-garden p-5 space-y-4"
  data-settings-section="providers"
>
  <ProviderRegistrySection
    modelsHref={`${base}/models`}
    {providerRegistry}
    {providerValidationErrors}
    {saving}
    isDirty={providerRegistryDirty()}
    inputClass={inputClass}
    labelClass={labelClass}
    toggleClass={toggleClass}
    providerCardClass={providerCardClass}
    {addProviderEntry}
    {removeProviderEntry}
    {updateProviderEntry}
    {setProviderType}
    {setProviderField}
    {saveProviderRegistry}
    {discardProviderRegistryChanges}
  />
</section>
