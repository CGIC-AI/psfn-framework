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
  class="garden-section card-garden space-y-3 p-5"
  data-settings-section="models"
>
  <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Models</p>
  <h2 class="garden-section-title font-serif text-lg font-semibold text-shadow-900">Model Registry and Purpose Routing</h2>
  <p class="text-sm text-shadow-600">
    Purpose-tagged primary/fallback models, model rosters, and context windows are managed in the dedicated Models workspace.
  </p>
  <a
    href={`${base}/models`}
    class="garden-action inline-flex min-h-10 items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-gold-700 transition-colors hover:bg-gold-100"
  >
    Open Models
  </a>
</section>

<section
  id={settingsSimpleSectionAnchorId('prompting')}
  class="garden-section card-garden space-y-3 p-5"
  data-settings-section="prompting"
>
  <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Prompting</p>
  <h2 class="garden-section-title font-serif text-lg font-semibold text-shadow-900">Prompt Stack and Authoring</h2>
  <p class="text-sm text-shadow-600">
    Prompt layers and authoring controls live in Prompts. Prompt assembly debugging lives in Prompt Monitor.
  </p>
  <div class="flex flex-wrap gap-2">
    <a
      href={`${base}/prompts`}
      class="garden-action inline-flex min-h-10 items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-gold-700 transition-colors hover:bg-gold-100"
    >
      Open Prompts
    </a>
    <a
      href={`${base}/prompt-monitor`}
      class="garden-action inline-flex min-h-10 items-center rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100"
    >
      Open Prompt Monitor
    </a>
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('providers')}
  class="garden-section card-garden space-y-4 overflow-hidden p-5"
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
