<script lang="ts">
  import { getContext } from 'svelte';
  import {
    SETTINGS_FIELD_ERRORS_CONTEXT,
    type SettingsFieldErrorsAccessor,
  } from '../../../routes/settings/settings-page-helpers';

  let {
    label,
    keys,
    source,
    forId,
    labelId,
    class: className = 'block text-sm font-medium text-shadow-700 mb-1.5',
  } = $props<{
    label: string;
    keys?: string | readonly string[];
    source?: string;
    forId?: string;
    labelId?: string;
    class?: string;
  }>();

  let keyList = $derived(
    typeof keys === 'string'
      ? [keys]
      : [...(keys ?? [])],
  );

  // Curated panels publish a validation-error accessor through context; labels
  // outside a curated panel (e.g. the provider registry editor) get undefined
  // and render no inline errors. Reading the accessor here keeps the errors
  // reactive to the controller's validationErrorsByField state.
  const fieldErrorsAccessor = getContext<SettingsFieldErrorsAccessor | undefined>(
    SETTINGS_FIELD_ERRORS_CONTEXT,
  );

  let fieldErrors = $derived(
    fieldErrorsAccessor
      ? [...new Set(keyList.flatMap((key) => fieldErrorsAccessor(key)))]
      : [],
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
  {#if fieldErrors.length > 0}
    <span class="mt-1 block space-y-0.5 font-normal">
      {#each fieldErrors as message}
        <span class="block text-sm text-wilt-600">{message}</span>
      {/each}
    </span>
  {/if}
{/snippet}

{#if forId}
  <label id={labelId} class={className} for={forId}>
    {@render labelContent()}
  </label>
{:else}
  <div id={labelId} class={className}>
    {@render labelContent()}
  </div>
{/if}
