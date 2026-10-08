<script lang="ts">
  import { CHANNEL_PRIVACY_LEVELS, type ChannelPrivacyLevel } from '$lib/types';

  let { level, value, editing = false, label, onchange }: {
    level?: ChannelPrivacyLevel;
    value?: ChannelPrivacyLevel;
    editing?: boolean;
    label: string;
    onchange?: (level: ChannelPrivacyLevel) => void;
  } = $props();

  const badges = {
    private: { cls: 'border border-moss-300 bg-moss-50 text-moss-800', label: 'Private' },
    invite_only: { cls: 'border border-gold-300 bg-gold-50 text-gold-800', label: 'Invite-Only' },
    public: { cls: 'border border-petal-300 bg-petal-50 text-petal-700', label: 'Public' },
  };
</script>

{#if editing}
  <select
    aria-label={label}
    value={value ?? level ?? ''}
    disabled={!level}
    onchange={(event) => onchange?.((event.target as HTMLSelectElement).value as ChannelPrivacyLevel)}
    class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
           focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
    {#if !level}<option value="">Unavailable</option>{/if}
    {#each CHANNEL_PRIVACY_LEVELS as privacy}
      <option value={privacy}>{privacy.replace('_', ' ')}</option>
    {/each}
  </select>
{:else if level}
  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium {badges[level].cls}">
    {badges[level].label}
  </span>
{:else}
  <span class="text-sm text-shadow-600">Privacy unavailable</span>
{/if}
