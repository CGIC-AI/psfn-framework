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

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-bark-900 font-semibold">Theme</h1>
    <p class="text-bark-700 text-sm mt-1">
      Choose a built-in theme pack for colors and left-menu labels.
    </p>
  </div>

  {#if successMessage}
    <div class="card-garden p-4 border-moss-300 bg-moss-50">
      <p class="text-sm text-moss-700">{successMessage}</p>
    </div>
  {/if}

  {#if errorMessage}
    <div class="card-garden p-4 border-wilt-400">
      <p class="text-sm text-wilt-600">{errorMessage}</p>
    </div>
  {/if}

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    {#each availableThemes as theme}
      <section class="card-garden p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="font-serif text-lg text-shadow-900">{theme.name}</h2>
            <p class="text-sm text-shadow-600 mt-1">{theme.description}</p>
          </div>
          {#if selectedThemeId === theme.id}
            <span class="text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50 text-moss-700">Active</span>
          {/if}
        </div>

        <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
          <p class="font-serif text-sm text-shadow-800">{previewTitle(theme)}</p>
          <p class="text-xs text-shadow-600 mt-1">
            {resolveThemeTemplate(theme.ui.sidebarSubtitleTemplate, { companionName })}
          </p>
        </div>

        <button
          class="mt-auto px-3 py-2 rounded-lg border border-bark-300 hover:border-gold-400 hover:bg-gold-50 transition-colors text-sm text-shadow-800 disabled:opacity-60 disabled:cursor-not-allowed"
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
      </section>
    {/each}
  </div>
</div>
