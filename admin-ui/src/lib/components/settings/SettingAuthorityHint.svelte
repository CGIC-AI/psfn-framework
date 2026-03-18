<script lang="ts">
  import type { SettingAuthorityInfo } from '$lib/settings/authority';

  let {
    info,
    className = '',
  } = $props<{
    info: SettingAuthorityInfo | null | undefined;
    className?: string;
  }>();
</script>

{#if info}
  <div class={`mt-2 rounded-lg border border-bark-200 bg-bark-50 px-3 py-2 text-sm text-shadow-700 ${className}`.trim()}>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-shadow-500">
      <span class="font-mono">{info.sourceLabel}</span>
      {#if info.effectiveValue}
        <span>effective {info.effectiveValue}</span>
      {/if}
    </div>
    <p class="mt-1">{info.detail}</p>
    {#if info.precedence}
      <p class="mt-1 text-xs text-shadow-500">{info.precedence}</p>
    {/if}
  </div>
{/if}
