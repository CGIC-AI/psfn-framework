<script lang="ts">
  import DurationInput from './DurationInput.svelte';
  import SettingAuthorityHint from './SettingAuthorityHint.svelte';
  import SettingFieldLabel from './SettingFieldLabel.svelte';
  import SettingsCollapsibleSection from './SettingsCollapsibleSection.svelte';
  import type { SettingAuthorityInfo } from '$lib/settings/authority';

  let {
    intervalMs = $bindable(),
    inputClass,
    source,
    authority,
  } = $props<{
    intervalMs: number;
    inputClass: string;
    source: string;
    authority: SettingAuthorityInfo;
  }>();

  let open = $state(false);
</script>

<SettingsCollapsibleSection
  title="Bundled Background Maintenance"
  {open}
  onToggle={() => (open = !open)}
  bodyClass="border-t border-bark-300 px-4 py-4"
>
  {#snippet summary()}
    <span class="text-xs text-shadow-500">Every {intervalMs.toLocaleString()} ms</span>
  {/snippet}
  <div>
    <SettingFieldLabel
      label="Maintenance interval"
      keys="backgroundMaintenanceIntervalMs"
      {source}
      forId="setting-backgroundMaintenanceIntervalMs"
      class="mb-1 block text-sm font-medium text-shadow-700"
    />
    <DurationInput
      id="setting-backgroundMaintenanceIntervalMs"
      min={10000}
      bind:value={intervalMs}
      class={inputClass}
    />
    <p class="mt-2 text-sm text-shadow-500">
      One shared hourly tick for salience decay, ambient presence, concern grooming, social-graph proposals,
      sleeptime eligibility, contact trust drift, drift velocity, and second-arrow checks.
    </p>
    <SettingAuthorityHint info={authority} />
  </div>
</SettingsCollapsibleSection>
