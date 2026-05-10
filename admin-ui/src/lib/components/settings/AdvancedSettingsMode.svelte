<script lang="ts">
  import type {
    AdminSettingsData,
    SettingsContractField,
  } from '$lib/types';

  export type AdvancedSettingEditorType = 'text' | 'number' | 'checkbox' | 'array' | 'object' | 'enum';

  export interface AdvancedSettingsSection {
    id: string;
    title: string;
    icon: string;
    keys: string[];
  }

  type CompositionalListKey = 'allowedTiers' | 'allowedChannelTypes' | 'allowedPurposes';

  interface CompositionalPolicyFormValue {
    enabled: boolean;
    allowedTiers: string[];
    allowedChannelTypes: string[];
    allowedPurposes: string[];
  }

  let {
    data,
    sections,
    sectionSummaries,
    openSections,
    modelOwnedFields,
    saving,
    capabilityTierOptions,
    compositionalChannelTypeOptions,
    compositionalPurposeOptions,
    toggleSection,
    configValue,
    setConfigValue,
    fieldEditorType,
    fieldEnumValues,
    fieldContract,
    fieldMinimum,
    fieldMaximum,
    isDeprecatedField,
    getSource,
    hasFieldErrors,
    fieldErrors,
    formatSettingOptionLabel,
    humanizeSettingValue,
    getCompositionalPolicy,
    setCompositionalPolicyEnabled,
    toggleCompositionalPolicyValue,
    hasCompositionalPolicyValue,
    saveAdvanced,
  } = $props<{
    data: AdminSettingsData | null;
    sections: AdvancedSettingsSection[];
    sectionSummaries: Record<string, string>;
    openSections: Set<string>;
    modelOwnedFields: Set<string>;
    saving: boolean;
    capabilityTierOptions: string[];
    compositionalChannelTypeOptions: readonly string[];
    compositionalPurposeOptions: readonly string[];
    toggleSection: (id: string) => void;
    configValue: (key: string) => unknown;
    setConfigValue: (key: string, value: unknown) => void;
    fieldEditorType: (key: string, value: unknown) => AdvancedSettingEditorType;
    fieldEnumValues: (key: string, fallback?: readonly string[]) => string[];
    fieldContract: (key: string) => SettingsContractField | undefined;
    fieldMinimum: (key: string) => number | undefined;
    fieldMaximum: (key: string) => number | undefined;
    isDeprecatedField: (key: string) => boolean;
    getSource: (key: string) => string;
    hasFieldErrors: (key: string) => boolean;
    fieldErrors: (key: string) => string[];
    formatSettingOptionLabel: (field: string, value: string) => string;
    humanizeSettingValue: (value: string) => string;
    getCompositionalPolicy: () => CompositionalPolicyFormValue;
    setCompositionalPolicyEnabled: (enabled: boolean) => void;
    toggleCompositionalPolicyValue: (listKey: CompositionalListKey, value: string) => void;
    hasCompositionalPolicyValue: (listKey: CompositionalListKey, value: string) => boolean;
    saveAdvanced: () => void | Promise<void>;
  }>();

  const FIELD_INPUT_CLASS = 'flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300';

  function visibleSectionKeys(section: AdvancedSettingsSection): string[] {
    return section.keys.filter((key) => (
      data
      && key in (data.config as Record<string, unknown>)
      && !modelOwnedFields.has(key)
      && !isDeprecatedField(key)
    ));
  }

  function otherSettingKeys(): string[] {
    if (!data) return [];
    const allCategorized = new Set<string>(
      sections.flatMap((section: AdvancedSettingsSection) => section.keys),
    );
    return Object.keys(data.config as Record<string, unknown>).filter((key) => (
      !allCategorized.has(key)
      && !modelOwnedFields.has(key)
      && !isDeprecatedField(key)
    ));
  }

  function advancedControlId(key: string, suffix = 'input'): string {
    return `advanced-setting-${key.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}-${suffix}`;
  }

  function advancedLabelId(key: string): string {
    return advancedControlId(key, 'label');
  }
</script>

<div class="space-y-3">
  <div class="rounded-2xl border border-bark-300 bg-bark-100/70 px-4 py-3 text-sm text-shadow-700">
    Legacy and removed runtime keys are hidden here. Garden only shows canonical settings; if an old key is submitted through a raw editor or API call, save validation will return migration guidance instead of silently accepting it.
  </div>
  {#each sections as section}
    {@const sectionKeys = visibleSectionKeys(section)}
    {#if sectionKeys.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection(section.id)}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">
              {section.icon}
            </span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">{section.title}</h2>
            <span class="text-sm text-shadow-500">({sectionKeys.length} fields)</span>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has(section.id)}
              <span class="text-sm text-shadow-500 hidden md:inline">{sectionSummaries[section.id]}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has(section.id) ? 'rotate-180' : ''}">
              &#9660;
            </span>
          </div>
        </button>
        {#if openSections.has(section.id)}
          <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
            {#each sectionKeys as key}
              {@const value = configValue(key)}
              {@const editorType = fieldEditorType(key, value)}
              {@const enumValues = fieldEnumValues(key, typeof value === 'string' ? [value] : [])}
              {@const fieldSchema = fieldContract(key)}
              <div class="flex flex-col sm:flex-row sm:items-start gap-2">
                <div id={advancedLabelId(key)} class="sm:w-60 shrink-0 flex items-center gap-2">
                  <span class="text-sm font-mono text-shadow-700">{key}</span>
                  <span class="text-shadow-400 text-sm">({getSource(key)})</span>
                  {#if fieldSchema?.deprecated}
                    <span class="rounded-full border border-wilt-300 bg-wilt-50 px-2 py-0.5 text-xs font-medium text-wilt-600">deprecated</span>
                  {/if}
                </div>
                {#if key === 'compositionalPolicy'}
                  {@const policy = getCompositionalPolicy()}
                  <div class="flex-1 space-y-4 rounded-2xl border border-bark-300 bg-bark-100/60 p-4">
                    <div class="space-y-2">
                      <p class="text-sm text-shadow-600">
                        Gate compositional cognition by capability tier, channel type, and purpose.
                        This remains JSON-backed runtime config; secrets stay in the environment.
                      </p>
                      <label class="inline-flex items-center gap-3 rounded-full border border-gold-300 bg-gold-50 px-3 py-2 text-sm font-medium text-shadow-800 cursor-pointer">
                        <input
                          id={advancedControlId('compositionalPolicy', 'enabled')}
                          aria-labelledby={advancedLabelId('compositionalPolicy')}
                          type="checkbox"
                          checked={policy.enabled}
                          onchange={(event) => setCompositionalPolicyEnabled((event.target as HTMLInputElement).checked)}
                          class="w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300"
                        />
                        <span>Enable compositional cognition</span>
                      </label>
                    </div>

                    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
                      <div class="space-y-2">
                        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-shadow-500">Allowed Tiers</p>
                        <div class="flex flex-wrap gap-2">
                          {#each capabilityTierOptions as option}
                            <label
                              class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer transition-colors {hasCompositionalPolicyValue('allowedTiers', option) ? 'border-gold-400 bg-gold-100 text-shadow-800' : 'border-bark-300 bg-white text-shadow-600 hover:bg-bark-100'}"
                            >
                              <input
                                aria-label={`Toggle ${option} compositional tier`}
                                type="checkbox"
                                checked={hasCompositionalPolicyValue('allowedTiers', option)}
                                onchange={() => toggleCompositionalPolicyValue('allowedTiers', option)}
                                class="sr-only"
                              />
                              <span>{formatSettingOptionLabel('capabilityTier', option)}</span>
                            </label>
                          {/each}
                        </div>
                      </div>

                      <div class="space-y-2">
                        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-shadow-500">Allowed Channels</p>
                        <div class="flex flex-wrap gap-2">
                          {#each compositionalChannelTypeOptions as option}
                            <label
                              class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer transition-colors {hasCompositionalPolicyValue('allowedChannelTypes', option) ? 'border-gold-400 bg-gold-100 text-shadow-800' : 'border-bark-300 bg-white text-shadow-600 hover:bg-bark-100'}"
                            >
                              <input
                                aria-label={`Toggle ${option} compositional channel`}
                                type="checkbox"
                                checked={hasCompositionalPolicyValue('allowedChannelTypes', option)}
                                onchange={() => toggleCompositionalPolicyValue('allowedChannelTypes', option)}
                                class="sr-only"
                              />
                              <span>{humanizeSettingValue(option)}</span>
                            </label>
                          {/each}
                        </div>
                      </div>

                      <div class="space-y-2">
                        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-shadow-500">Allowed Purposes</p>
                        <div class="flex flex-wrap gap-2">
                          {#each compositionalPurposeOptions as option}
                            <label
                              class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer transition-colors {hasCompositionalPolicyValue('allowedPurposes', option) ? 'border-gold-400 bg-gold-100 text-shadow-800' : 'border-bark-300 bg-white text-shadow-600 hover:bg-bark-100'}"
                            >
                              <input
                                aria-label={`Toggle ${option} compositional purpose`}
                                type="checkbox"
                                checked={hasCompositionalPolicyValue('allowedPurposes', option)}
                                onchange={() => toggleCompositionalPolicyValue('allowedPurposes', option)}
                                class="sr-only"
                              />
                              <span>{humanizeSettingValue(option)}</span>
                            </label>
                          {/each}
                        </div>
                      </div>
                    </div>
                  </div>
                {:else if editorType === 'checkbox'}
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input
                      id={advancedControlId(key)}
                      aria-labelledby={advancedLabelId(key)}
                      type="checkbox"
                      checked={Boolean(value)}
                      onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).checked)}
                      class="sr-only peer" />
                    <div class="w-9 h-5 bg-bark-400 rounded-full peer
                                peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                peer-checked:after:translate-x-full"></div>
                  </label>
                {:else if editorType === 'enum'}
                  <select
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    value={String(value ?? '')}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLSelectElement).value)}
                    class={FIELD_INPUT_CLASS}
                  >
                    {#each enumValues as option}
                      <option value={option}>{formatSettingOptionLabel(key, option)}</option>
                    {/each}
                  </select>
                {:else if editorType === 'number'}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="number"
                    value={Number(value)}
                    min={fieldMinimum(key)}
                    max={fieldMaximum(key)}
                    onchange={(event) => setConfigValue(key, Number((event.target as HTMLInputElement).value))}
                    class={FIELD_INPUT_CLASS} />
                {:else if editorType === 'array'}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="text"
                    value={Array.isArray(value) ? value.join(', ') : ''}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).value.split(',').map((entry) => entry.trim()).filter(Boolean))}
                    class={FIELD_INPUT_CLASS}
                    placeholder="comma-separated values" />
                {:else if editorType === 'object'}
                  <textarea
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    value={JSON.stringify(value, null, 2)}
                    onchange={(event) => { try { setConfigValue(key, JSON.parse((event.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                    rows="3"
                    class={`${FIELD_INPUT_CLASS} resize-y`}
                    spellcheck="false"
                  ></textarea>
                {:else}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="text"
                    value={String(value ?? '')}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).value)}
                    class={FIELD_INPUT_CLASS} />
                {/if}
              </div>
              {#if hasFieldErrors(key)}
                <div class="sm:pl-60 space-y-1">
                  {#each fieldErrors(key) as fieldError}
                    <p class="text-sm text-wilt-600">{fieldError}</p>
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}

  {#if data}
    {@const otherKeys = otherSettingKeys()}
    {#if otherKeys.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('other')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">
              ?
            </span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Other Settings</h2>
            <span class="text-sm text-shadow-500">({otherKeys.length} fields)</span>
          </div>
          <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('other') ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if openSections.has('other')}
          <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
            {#each otherKeys as key}
              {@const value = configValue(key)}
              {@const editorType = fieldEditorType(key, value)}
              {@const enumValues = fieldEnumValues(key, typeof value === 'string' ? [value] : [])}
              {@const fieldSchema = fieldContract(key)}
              <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                <div id={advancedLabelId(key)} class="sm:w-60 shrink-0 flex items-center gap-2">
                  <span class="text-sm font-mono text-shadow-700">{key}</span>
                  <span class="text-shadow-400 text-sm">({getSource(key)})</span>
                  {#if fieldSchema?.deprecated}
                    <span class="rounded-full border border-wilt-300 bg-wilt-50 px-2 py-0.5 text-xs font-medium text-wilt-600">deprecated</span>
                  {/if}
                </div>
                {#if editorType === 'checkbox'}
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input
                      id={advancedControlId(key)}
                      aria-labelledby={advancedLabelId(key)}
                      type="checkbox"
                      checked={Boolean(value)}
                      onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).checked)}
                      class="sr-only peer" />
                    <div class="w-9 h-5 bg-bark-400 rounded-full peer
                                peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                peer-checked:after:translate-x-full"></div>
                  </label>
                {:else if editorType === 'enum'}
                  <select
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    value={String(value ?? '')}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLSelectElement).value)}
                    class={FIELD_INPUT_CLASS}
                  >
                    {#each enumValues as option}
                      <option value={option}>{formatSettingOptionLabel(key, option)}</option>
                    {/each}
                  </select>
                {:else if editorType === 'number'}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="number"
                    value={Number(value)}
                    min={fieldMinimum(key)}
                    max={fieldMaximum(key)}
                    onchange={(event) => setConfigValue(key, Number((event.target as HTMLInputElement).value))}
                    class={FIELD_INPUT_CLASS} />
                {:else if editorType === 'array'}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="text"
                    value={Array.isArray(value) ? value.join(', ') : ''}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).value.split(',').map((entry) => entry.trim()).filter(Boolean))}
                    class={FIELD_INPUT_CLASS}
                    placeholder="comma-separated values" />
                {:else if editorType === 'object'}
                  <textarea
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    value={JSON.stringify(value, null, 2)}
                    onchange={(event) => { try { setConfigValue(key, JSON.parse((event.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                    rows="3"
                    class={`${FIELD_INPUT_CLASS} resize-y`}
                    spellcheck="false"
                  ></textarea>
                {:else}
                  <input
                    id={advancedControlId(key)}
                    aria-labelledby={advancedLabelId(key)}
                    type="text"
                    value={String(value ?? '')}
                    onchange={(event) => setConfigValue(key, (event.target as HTMLInputElement).value)}
                    class={FIELD_INPUT_CLASS} />
                {/if}
              </div>
              {#if hasFieldErrors(key)}
                <div class="sm:pl-60 space-y-1">
                  {#each fieldErrors(key) as fieldError}
                    <p class="text-sm text-wilt-600">{fieldError}</p>
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="flex items-center gap-3 pt-2">
    <button onclick={saveAdvanced} disabled={saving}
      class="px-5 py-2.5 rounded-lg bg-gold-600 text-white text-sm font-medium
             hover:bg-gold-700 disabled:opacity-50 transition-colors shadow-sm">
      {saving ? 'Saving...' : 'Save All Settings'}
    </button>
  </div>
</div>
