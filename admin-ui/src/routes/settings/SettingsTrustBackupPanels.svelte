<script lang="ts">
  import { setContext } from 'svelte';
  import SettingAuthorityHint from '$lib/components/settings/SettingAuthorityHint.svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import SettingsCollapsibleSection from '$lib/components/settings/SettingsCollapsibleSection.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import type { AdminSettingsData } from '$lib/types';
  import type { SettingAuthorityInfo } from '$lib/settings/authority';
  import {
    SETTINGS_FIELD_ERRORS_CONTEXT,
    formatSettingOptionLabel,
    settingControlId,
    type RawEditorKey,
    type SettingsFieldErrorsAccessor,
  } from './settings-page-helpers';

  let {
    data,
    openSections,
    capabilityTierOptions,
    inputClass,
    labelClass,
    toggleClass,
    getSource,
    getSettingAuthority,
    rawEditorLabel,
    fieldErrors,
    toggleSection,
    capabilityTier = $bindable('apprentice'),
    capabilityCustomTokens = $bindable(''),
    backupIntervalHours = $bindable(12),
    backupMaxRotating = $bindable(9),
    backupMaxWeekly = $bindable(2),
    backupMaxMonthly = $bindable(1),
    backupMirrorDir = $bindable(''),
    backupVerifyRestore = $bindable(true),
  } = $props<{
    data: AdminSettingsData | null;
    openSections: Set<string>;
    capabilityTierOptions: string[];
    inputClass: string;
    labelClass: string;
    toggleClass: string;
    getSource: (key: string) => string;
    getSettingAuthority: (key: string) => SettingAuthorityInfo;
    rawEditorLabel: (key: RawEditorKey) => string;
    fieldErrors: SettingsFieldErrorsAccessor;
    toggleSection: (id: string) => void;
    capabilityTier: string;
    capabilityCustomTokens: string;
    backupIntervalHours: number;
    backupMaxRotating: number;
    backupMaxWeekly: number;
    backupMaxMonthly: number;
    backupMirrorDir: string;
    backupVerifyRestore: boolean;
  }>();

  // Publish the validation-error accessor to descendant SettingFieldLabels so
  // curated controls render their field's errors inline (ybm3).
  setContext<SettingsFieldErrorsAccessor>(SETTINGS_FIELD_ERRORS_CONTEXT, (key) => fieldErrors(key));
</script>

<section
  id={settingsSimpleSectionAnchorId('advanced-trust')}
  data-settings-section="advanced-trust"
>
  <SettingsCollapsibleSection
    title="Trust & Capabilities"
    open={openSections.has('trust')}
    onToggle={() => toggleSection('trust')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">Tier: {capabilityTier}</span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel
          label="Capability Tier"
          keys="capabilityTier"
          source={getSource('capabilityTier')}
          forId={settingControlId('capabilityTier')}
          class={labelClass}
        />
        <select id={settingControlId('capabilityTier')} bind:value={capabilityTier} class={inputClass}>
          {#each capabilityTierOptions as tier}
            <option value={tier}>{formatSettingOptionLabel('capabilityTier', tier)}</option>
          {/each}
        </select>
        <p class="text-sm text-shadow-500 mt-1">Controls agent autonomy level</p>
        <SettingAuthorityHint info={getSettingAuthority('capabilityTier')} />
      </div>
      <div class="md:col-span-2">
        <SettingFieldLabel
          label="Custom Capability Tokens"
          keys="customTokens"
          source={getSource('customTokens')}
          forId={settingControlId('customTokens')}
          class={labelClass}
        />
        <input
          id={settingControlId('customTokens')}
          type="text"
          bind:value={capabilityCustomTokens}
          class={inputClass}
          placeholder="identity.read, git.read"
          disabled={capabilityTier !== 'custom'}
        />
        <p class="text-sm text-shadow-500 mt-1">
          Comma-separated capability tokens for the <span class="font-mono">custom</span> tier. Saved to {rawEditorLabel('capabilities')}.
        </p>
        <SettingAuthorityHint info={getSettingAuthority('customTokens')} />
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>

{#if data?.env}
  {@const env = data.env as unknown as Record<string, unknown>}
  <section
    id={settingsSimpleSectionAnchorId('advanced-secrets')}
    data-settings-section="advanced-secrets"
  >
    <SettingsCollapsibleSection
      title="Secrets (Read-Only)"
      open={openSections.has('secrets')}
      onToggle={() => toggleSection('secrets')}
    >
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-bark-300">
              <th class="text-left py-2 text-shadow-700 font-medium">Key</th>
              <th class="text-left py-2 text-shadow-700 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {#each [
              ['DISCORD_TOKEN', env.discordToken],
              ['API_KEY', env.apiKey],
              ['ADMIN_TOKEN', env.adminToken],
              ['OPENROUTER_API_KEY', env.openrouterApiKey],
              ['LITELLM_BASE_URL', env.litellmBaseUrl],
              ['LITELLM_API_KEY', env.litellmApiKey],
            ] as pair}
              <tr class="border-b border-bark-200">
                <td class="py-2 font-mono text-shadow-700">{pair[0]}</td>
                <td class="py-2 font-mono text-shadow-600">{String(pair[1] ?? '(not set)')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </SettingsCollapsibleSection>
  </section>
{/if}

<section
  id={settingsSimpleSectionAnchorId('advanced-backup')}
  data-settings-section="advanced-backup"
>
  <SettingsCollapsibleSection
    title="Backups"
    open={openSections.has('backup')}
    onToggle={() => toggleSection('backup')}
  >
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel label="Interval (hours)" keys="intervalHours" forId={settingControlId('intervalHours')} class={labelClass} />
        <input id={settingControlId('intervalHours')} type="number" min="1" max="168" bind:value={backupIntervalHours} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">How often to run a backup cycle</p>
      </div>
      <div>
        <SettingFieldLabel label="Rotating backups" keys="maxRotatingBackups" forId={settingControlId('maxRotatingBackups')} class={labelClass} />
        <input id={settingControlId('maxRotatingBackups')} type="number" min="1" max="99" bind:value={backupMaxRotating} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Most-recent backups to keep</p>
      </div>
      <div>
        <SettingFieldLabel label="Weekly backups" keys="maxWeeklyBackups" forId={settingControlId('maxWeeklyBackups')} class={labelClass} />
        <input id={settingControlId('maxWeeklyBackups')} type="number" min="0" max="52" bind:value={backupMaxWeekly} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Weekly slots (derived from rotating cycle)</p>
      </div>
      <div>
        <SettingFieldLabel label="Monthly backups" keys="maxMonthlyBackups" forId={settingControlId('maxMonthlyBackups')} class={labelClass} />
        <input id={settingControlId('maxMonthlyBackups')} type="number" min="0" max="24" bind:value={backupMaxMonthly} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Monthly slots (derived from rotating cycle)</p>
      </div>
      <div class="md:col-span-2">
        <SettingFieldLabel label="Mirror directory" keys="mirrorDir" forId={settingControlId('mirrorDir')} class={labelClass} />
        <input id={settingControlId('mirrorDir')} type="text" bind:value={backupMirrorDir} class={inputClass} placeholder="/path/to/backup-mirror" />
        <p class="text-sm text-shadow-500 mt-1">Secondary backup mirror path (leave blank to disable)</p>
      </div>
      <div class="md:col-span-2 flex items-center gap-3">
        <input type="checkbox" id="backup-verify-restore" bind:checked={backupVerifyRestore} class={toggleClass} />
        <label for="backup-verify-restore" class="text-sm text-shadow-700">
          Verify restore integrity after each backup
          <code class="ml-1.5 rounded-md border border-bark-200 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-shadow-600">verifyRestore</code>
        </label>
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>
