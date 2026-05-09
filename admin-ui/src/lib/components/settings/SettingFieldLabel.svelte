<script lang="ts">
  let {
    label,
    keys,
    source,
    forId,
    class: className = 'block text-sm font-medium text-shadow-700 mb-1.5',
  } = $props<{
    label: string;
    keys?: string | readonly string[];
    source?: string;
    forId?: string;
    class?: string;
  }>();

  let keyList = $derived(
    typeof keys === 'string'
      ? [keys]
      : [...(keys ?? [])],
  );
</script>

{#snippet labelContent()}
  <span>{label}</span>
  {#if source}
    <span class="text-shadow-400 font-normal ml-1">({source})</span>
  {/if}
  {#each keyList as key}
    <code class="ml-1.5 rounded-md border border-bark-200 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-shadow-600">
      {key}
    </code>
  {/each}
{/snippet}

{#if forId}
  <label class={className} for={forId}>
    {@render labelContent()}
  </label>
{:else}
  <div class={className}>
    {@render labelContent()}
  </div>
{/if}
