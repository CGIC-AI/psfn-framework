<script lang="ts">
  import type {
    AdminSettingsData,
    SettingsContractField,
  } from '$lib/types';
  import AdvancedSettingsMode, {
    type AdvancedSettingEditorType,
  } from '$lib/components/settings/AdvancedSettingsMode.svelte';
  import RawSettingsMode from '$lib/components/settings/RawSettingsMode.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import type {
    AdvancedSettingsSectionDef,
    CompositionalListKey,
    CompositionalPolicyFormValue,
    RawEditorKey,
    RawSettingsEditorKey,
  } from './settings-page-helpers';

  let {
    view,
    data,
    SECTIONS,
    advancedSectionSummaries,
    openSections,
    MODEL_OWNED_FIELDS,
    saving,
    capabilityTierOptions,
    COMPOSITIONAL_CHANNEL_TYPE_OPTIONS,
    COMPOSITIONAL_PURPOSE_OPTIONS,
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
    settingsJson,
    rawEditorViews,
    rawSaveStatus,
    retryingRawEditorKey,
    validationErrorsByField,
    setSettingsJson,
    getRawJson,
    setRawJson,
    saveRawSettings,
    saveRawConfig,
    retryRawConfig,
  } = $props<{
    view: 'fields' | 'raw';
    data: AdminSettingsData | null;
    SECTIONS: AdvancedSettingsSectionDef[];
    advancedSectionSummaries: Record<string, string>;
    openSections: Set<string>;
    MODEL_OWNED_FIELDS: Set<string>;
    saving: boolean;
    capabilityTierOptions: string[];
    COMPOSITIONAL_CHANNEL_TYPE_OPTIONS: readonly string[];
    COMPOSITIONAL_PURPOSE_OPTIONS: readonly string[];
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
    settingsJson: string;
    rawEditorViews: { key: RawSettingsEditorKey; ownerFile: string; loadError?: string }[];
    rawSaveStatus: Record<string, { ok: boolean; msg: string }>;
    retryingRawEditorKey: RawSettingsEditorKey | null;
    validationErrorsByField: Record<string, string[]>;
    setSettingsJson: (value: string) => void;
    getRawJson: (key: string) => string;
    setRawJson: (key: string, value: string) => void;
    saveRawSettings: () => void | Promise<void>;
    saveRawConfig: (key: string, label: string) => void | Promise<void>;
    retryRawConfig: (key: RawSettingsEditorKey) => void | Promise<void>;
  }>();
</script>

{#if view === 'fields'}
          <section
            id={settingsSimpleSectionAnchorId('advanced-fields')}
            class="space-y-4"
            data-settings-section="advanced-fields"
          >
            <div class="card-garden p-5 space-y-2">
              <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Runtime</p>
              <h2 class="text-sm font-serif font-semibold text-shadow-800">All Canonical Fields</h2>
              <p class="text-sm text-shadow-600">
                Full contract-backed runtime fields stay in this workspace for operator access.
                Validation errors open the owning canonical group instead of switching modes.
              </p>
            </div>
            <AdvancedSettingsMode
              {data}
              sections={SECTIONS}
              sectionSummaries={advancedSectionSummaries}
              {openSections}
              modelOwnedFields={MODEL_OWNED_FIELDS}
              {capabilityTierOptions}
              compositionalChannelTypeOptions={COMPOSITIONAL_CHANNEL_TYPE_OPTIONS}
              compositionalPurposeOptions={COMPOSITIONAL_PURPOSE_OPTIONS}
              {toggleSection}
              {configValue}
              {setConfigValue}
              {fieldEditorType}
              {fieldEnumValues}
              {fieldContract}
              {fieldMinimum}
              {fieldMaximum}
              {isDeprecatedField}
              {getSource}
              {hasFieldErrors}
              {fieldErrors}
              {formatSettingOptionLabel}
              {humanizeSettingValue}
              {getCompositionalPolicy}
              {setCompositionalPolicyEnabled}
              {toggleCompositionalPolicyValue}
              {hasCompositionalPolicyValue}
            />
          </section>
{:else}
          <section
            id={settingsSimpleSectionAnchorId('owner-files')}
            class="space-y-4"
            data-settings-section="owner-files"
          >
            <div class="card-garden p-5 space-y-2">
              <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Owner Files</p>
              <h2 class="text-sm font-serif font-semibold text-shadow-800">Raw Owner-File Editors</h2>
              <p class="text-sm text-shadow-600">
                JSON owner files remain editable in place. Raw edits save directly to their
                owner files here. Staged (unsaved) raw edits are preserved across the unified
                settings save, which skips those owner files until you save or discard the
                staged edits on this tab; staged edits are flagged on the Raw JSON tab badge.
              </p>
            </div>
            <RawSettingsMode
              {settingsJson}
              rawEditors={rawEditorViews}
              {rawSaveStatus}
              {saving}
              {retryingRawEditorKey}
              {validationErrorsByField}
              {setSettingsJson}
              {getRawJson}
              {setRawJson}
              {saveRawSettings}
              {saveRawConfig}
              {retryRawConfig}
            />
          </section>
{/if}
