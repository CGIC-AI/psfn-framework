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
  <div class="garden-error" role="alert">
    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-wilt-100 font-semibold text-wilt-700" aria-hidden="true">!</div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-wilt-800">{errorLabel}</p>
      <p class="mt-1 text-xs text-wilt-700">{loadError}</p>
      <button
        type="button"
        onclick={() => void loadComponent()}
        class="garden-action mt-3 text-xs"
      >
        Retry
      </button>
    </div>
  </div>
{:else}
  <div class="garden-loading" aria-busy="true">
    <span class="h-2 w-2 animate-pulse rounded-full bg-gold-500" aria-hidden="true"></span>
    <span>{loadingLabel}</span>
  </div>
{/if}
