<script lang="ts">
  import type { NorthStarScope } from '$lib/types';
  import type { NorthStarDraftItem } from './page-helpers';

  type UpdateNorthStarItem = <T extends keyof NorthStarDraftItem>(
    clientKey: string,
    field: T,
    value: NorthStarDraftItem[T],
  ) => void;

  interface Props {
    showNorthStarSection: boolean;
    northStarLoading: boolean;
    northStarError: string;
    northStarItems: NorthStarDraftItem[];
    northStarLimit: number;
    northStarPreviewText: string;
    northStarPreviewTokenCount: string;
    northStarSaving: boolean;
    northStarSaveMessage: string;
    onToggleNorthStarSection: () => void;
    addNorthStarItem: () => void;
    moveNorthStarItem: (index: number, direction: 'up' | 'down') => void;
    removeNorthStarItem: (clientKey: string) => void;
    updateNorthStarItem: UpdateNorthStarItem;
    saveNorthStar: () => void | Promise<void>;
  }

  let {
    showNorthStarSection,
    northStarLoading,
    northStarError,
    northStarItems,
    northStarLimit,
    northStarPreviewText,
    northStarPreviewTokenCount,
    northStarSaving,
    northStarSaveMessage,
    onToggleNorthStarSection,
    addNorthStarItem,
    moveNorthStarItem,
    removeNorthStarItem,
    updateNorthStarItem,
    saveNorthStar,
  }: Props = $props();
</script>

<div id="north-star-editor" class="card-garden overflow-hidden">
  <button
    onclick={onToggleNorthStarSection}
    class="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-bark-100 transition-colors"
  >
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-800">North Star</h2>
      <p class="text-sm text-shadow-600 mt-0.5">Three long-term goals max. This prompt block sits immediately after constitution.</p>
    </div>
    <svg class="w-4 h-4 text-shadow-600 transition-transform shrink-0 ml-4 {showNorthStarSection ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  {#if showNorthStarSection}
    <div class="border-t border-bark-300 p-5 space-y-4">
      {#if northStarLoading}
        <div class="space-y-2">
          {#each Array(2) as _}
            <div class="h-16 rounded-lg bg-bark-200 animate-pulse"></div>
          {/each}
        </div>
      {:else}
        {#if northStarError}
          <div class="px-3 py-2 rounded-lg border border-wilt-400 bg-wilt-50 text-sm text-wilt-700">
            {northStarError}
          </div>
        {/if}

        <div class="flex items-center justify-between">
          <div class="text-sm text-shadow-600">
            {northStarItems.length} / {northStarLimit} goals
          </div>
          <button
            onclick={addNorthStarItem}
            disabled={northStarItems.length >= northStarLimit}
            class="px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 text-sm hover:bg-bark-100 disabled:opacity-50 transition-colors"
          >
            Add Goal
          </button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div class="space-y-3">
            {#if northStarItems.length === 0}
              <div class="rounded-lg border border-dashed border-bark-300 bg-bark-50 p-4 text-sm text-shadow-600">
                No North Star goals yet.
              </div>
            {:else}
              {#each northStarItems as item, idx (item.clientKey)}
                <div class="rounded-lg border border-bark-300 bg-white p-3 space-y-3">
                  <div class="flex items-center gap-2">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gold-200 text-shadow-800">
                      #{idx + 1}
                    </span>
                    <span class="text-sm text-shadow-600">{item.scope === 'shared' ? 'Shared' : 'Companion'}</span>
                    <div class="ml-auto flex items-center gap-2">
                      <button
                        onclick={() => moveNorthStarItem(idx, 'up')}
                        disabled={idx === 0}
                        class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                      >
                        Up
                      </button>
                      <button
                        onclick={() => moveNorthStarItem(idx, 'down')}
                        disabled={idx === northStarItems.length - 1}
                        class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                      >
                        Down
                      </button>
                      <button
                        onclick={() => removeNorthStarItem(item.clientKey)}
                        class="px-2 py-0.5 rounded border border-wilt-300 text-sm text-wilt-700 hover:bg-wilt-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-[1fr_11rem] gap-3">
                    <label class="block">
                      <span class="block text-sm font-medium text-shadow-700 mb-1">Title</span>
                      <input
                        type="text"
                        value={item.title}
                        oninput={(e) => updateNorthStarItem(item.clientKey, 'title', (e.target as HTMLInputElement).value)}
                        class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      />
                    </label>
                    <label class="block">
                      <span class="block text-sm font-medium text-shadow-700 mb-1">Scope</span>
                      <select
                        value={item.scope}
                        onchange={(e) => updateNorthStarItem(item.clientKey, 'scope', (e.target as HTMLSelectElement).value as NorthStarScope)}
                        class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      >
                        <option value="shared">Shared</option>
                        <option value="companion">Companion</option>
                      </select>
                    </label>
                  </div>

                  <label class="block">
                    <span class="block text-sm font-medium text-shadow-700 mb-1">Guidance</span>
                    <textarea
                      rows={4}
                      value={item.content}
                      oninput={(e) => updateNorthStarItem(item.clientKey, 'content', (e.target as HTMLTextAreaElement).value)}
                      class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                    ></textarea>
                  </label>

                  <label class="inline-flex items-center gap-1.5 text-sm text-shadow-700">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onchange={(e) => updateNorthStarItem(item.clientKey, 'enabled', (e.target as HTMLInputElement).checked)}
                    />
                    enabled in prompt
                  </label>
                </div>
              {/each}
            {/if}
          </div>

          <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Preview Output</h3>
              <span class="text-sm text-shadow-600">~{northStarPreviewTokenCount} tokens</span>
            </div>
            <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-white/60 p-3 rounded border border-bark-200 max-h-80 overflow-y-auto leading-relaxed">{northStarPreviewText || 'No enabled North Star goals.'}</pre>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={saveNorthStar}
            disabled={northStarSaving}
            class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
          >
            {northStarSaving ? 'Saving...' : 'Save North Star'}
          </button>
          {#if northStarSaveMessage}
            <span class="text-sm text-moss-700">{northStarSaveMessage}</span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
