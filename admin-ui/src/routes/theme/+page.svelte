<script lang="ts">
  import { onMount } from 'svelte';
  import { getCompanionName } from '$lib/stores/companion.svelte';
  import {
    ensureUiPreferencesLoaded,
    getActiveThemePack,
    getAvailableThemePacks,
    getSelectedThemeId,
    saveSelectedTheme,
  } from '$lib/stores/ui-preferences.svelte';
  import CardGrid from '$lib/components/garden/CardGrid.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { resolveThemeTemplate } from '$lib/theme/loader';
  import type { ThemePackDefinition } from '$lib/theme/schema';

  let savingThemeId = $state<string | null>(null);
  let successMessage = $state('');
  let errorMessage = $state('');
  const companionName = $derived(getCompanionName());
  const selectedThemeId = $derived(getSelectedThemeId());
  const activeTheme = $derived(getActiveThemePack());
  const availableThemes = $derived(getAvailableThemePacks());

  onMount(() => {
    void ensureUiPreferencesLoaded();
  });

  function previewTitle(theme: ThemePackDefinition): string {
    return resolveThemeTemplate(theme.ui.sidebarTitleTemplate, { companionName });
  }

  function themeSwatches(theme: ThemePackDefinition): string[] {
    return [
      theme.cssVariables['--color-bark-100'],
      theme.cssVariables['--color-bark-50'],
      theme.cssVariables['--color-gold-500'],
      theme.cssVariables['--color-moss-500'],
      theme.cssVariables['--color-petal-500'],
      theme.cssVariables['--color-shadow-900'],
    ].filter((color): color is string => typeof color === 'string' && color.length > 0);
  }

  async function applyTheme(themeId: string): Promise<void> {
    if (savingThemeId) return;
    savingThemeId = themeId;
    errorMessage = '';
    successMessage = '';

    try {
      const result = await saveSelectedTheme(themeId);
      if (!result.ok) {
        errorMessage = result.message;
        return;
      }
      successMessage = `Theme changed to ${activeTheme.name}.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to save theme';
    } finally {
      savingThemeId = null;
    }
  }
</script>

<svelte:head>
  <title>Theme · Garden</title>
</svelte:head>

<div class="garden-page space-y-6 pb-10">
  {#snippet themeActions()}
    <span class="rounded-lg border border-moss-300 bg-moss-50 px-3 py-2 text-xs font-medium text-moss-700">
      Active · {activeTheme.name}
    </span>
  {/snippet}
  <GardenPageHeader
    eyebrow="Configure Garden · Appearance"
    title="Theme"
    description="Choose the palette and navigation language for this browser. Theme preference changes presentation only; runtime settings remain untouched."
    actions={themeActions}
  />

  {#if successMessage}
    <div class="rounded-xl border border-moss-300 bg-moss-50 p-4" role="status">
      <p class="text-sm text-moss-700">{successMessage}</p>
    </div>
  {/if}

  {#if errorMessage}
    <div class="rounded-xl border border-wilt-300 bg-wilt-50 p-4" role="alert">
      <p class="text-sm text-wilt-600">{errorMessage}</p>
    </div>
  {/if}

  <section class="card-garden grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]" aria-labelledby="active-theme-title">
    <div>
      <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Current selection</p>
      <h2 id="active-theme-title" class="mt-1 font-serif text-xl font-semibold text-shadow-900">{activeTheme.name}</h2>
      <p class="mt-2 max-w-2xl text-sm leading-relaxed text-shadow-600">{activeTheme.description}</p>
    </div>
    <div class="surface-sunken p-4">
      <p class="font-serif text-base font-semibold text-shadow-900">{previewTitle(activeTheme)}</p>
      <p class="mt-1 text-xs text-shadow-600">
        {resolveThemeTemplate(activeTheme.ui.sidebarSubtitleTemplate, { companionName })}
      </p>
      <div class="mt-4 flex gap-1.5" aria-label={`${activeTheme.name} palette`}>
        {#each themeSwatches(activeTheme) as color, index (`${color}-${index}`)}
          <span class="h-7 flex-1 rounded-md border border-bark-300" style={`background:${color}`} aria-hidden="true"></span>
        {/each}
      </div>
    </div>
  </section>

  <div>
    <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Available packs</p>
    <h2 class="mt-1 font-serif text-xl font-semibold text-shadow-900">Choose a visual system</h2>
    <p class="mt-1 text-sm text-shadow-600">Each pack changes colors and menu labels while preserving the same page hierarchy and interactions.</p>
  </div>

  <CardGrid>
    {#each availableThemes as theme}
      <section class="card-garden flex flex-col overflow-hidden">
        <div class="flex gap-0.5" aria-label={`${theme.name} palette`}>
          {#each themeSwatches(theme) as color, index (`${color}-${index}`)}
            <span class="h-2 flex-1" style={`background:${color}`} aria-hidden="true"></span>
          {/each}
        </div>
        <div class="flex flex-1 flex-col gap-3 p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="font-serif text-lg text-shadow-900">{theme.name}</h2>
            <p class="text-sm text-shadow-600 mt-1">{theme.description}</p>
          </div>
          {#if selectedThemeId === theme.id}
            <span class="text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50 text-moss-700">Active</span>
          {/if}
        </div>

        <div class="surface-sunken p-3">
          <p class="font-serif text-sm font-semibold text-shadow-800">{previewTitle(theme)}</p>
          <p class="text-xs text-shadow-600 mt-1">
            {resolveThemeTemplate(theme.ui.sidebarSubtitleTemplate, { companionName })}
          </p>
        </div>

        <button
          class="mt-auto min-h-10 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 {selectedThemeId === theme.id ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100'}"
          disabled={savingThemeId !== null || selectedThemeId === theme.id}
          onclick={() => applyTheme(theme.id)}
        >
          {#if savingThemeId === theme.id}
            Saving...
          {:else if selectedThemeId === theme.id}
            Selected
          {:else}
            Apply Theme
          {/if}
        </button>
        </div>
      </section>
    {/each}
  </CardGrid>
</div>
