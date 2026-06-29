<script lang="ts">
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';

  interface LazyComponentModule {
    default: Component;
  }

  interface Props {
    loader: () => Promise<LazyComponentModule>;
    loadingLabel?: string;
    errorLabel?: string;
  }

  let {
    loader,
    loadingLabel = 'Loading Garden page...',
    errorLabel = 'Failed to load Garden page.',
  }: Props = $props();

  let LoadedComponent = $state<Component | null>(null);
  let loadError = $state('');
  let loadGeneration = 0;

  function formatLoadError(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown lazy-load error.';
  }

  async function loadComponent(): Promise<void> {
    const generation = ++loadGeneration;
    loadError = '';
    try {
      const module = await loader();
      if (generation === loadGeneration) {
        LoadedComponent = module.default;
      }
    } catch (error) {
      if (generation === loadGeneration) {
        LoadedComponent = null;
        loadError = formatLoadError(error);
      }
    }
  }

  onMount(() => {
    void loadComponent();

    return () => {
      loadGeneration += 1;
    };
  });
</script>

{#if LoadedComponent}
  <LoadedComponent />
{:else if loadError}
  <div class="card-garden border-l-4 border-l-wilt-400 p-4">
    <p class="text-sm font-medium text-wilt-700">{errorLabel}</p>
    <p class="mt-1 text-xs text-wilt-600">{loadError}</p>
    <button
      type="button"
      onclick={() => void loadComponent()}
      class="mt-3 rounded-lg border border-bark-300 px-3 py-1.5 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100"
    >
      Retry
    </button>
  </div>
{:else}
  <div class="card-garden p-4 text-sm text-shadow-600" aria-busy="true">
    {loadingLabel}
  </div>
{/if}
