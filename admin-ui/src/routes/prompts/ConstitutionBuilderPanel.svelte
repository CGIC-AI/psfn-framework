<script lang="ts">
  import type {
    ConstitutionCompanionLayer,
    ConstitutionImmutableBlock,
  } from '$lib/types';

  interface Props {
    showConstitutionSection: boolean;
    constitutionLoading: boolean;
    constitutionError: string;
    constitutionImmutableBlocks: ConstitutionImmutableBlock[];
    constitutionCompanionLayer: ConstitutionCompanionLayer | null;
    constitutionPreviewText: string;
    constitutionPreviewTokenCount: string;
    onToggleConstitutionSection: () => void;
  }

  let {
    showConstitutionSection,
    constitutionLoading,
    constitutionError,
    constitutionImmutableBlocks,
    constitutionCompanionLayer,
    constitutionPreviewText,
    constitutionPreviewTokenCount,
    onToggleConstitutionSection,
  }: Props = $props();
</script>

<div id="constitution-builder" class="card-garden overflow-hidden">
  <button
    onclick={onToggleConstitutionSection}
    class="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-bark-100 transition-colors"
  >
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-800">Constitution Builder</h2>
      <p class="text-sm text-shadow-600 mt-0.5">Immutable amendments are locked. Constitution content is fixed here; editable runtime/operator layers live in the composition stack below.</p>
    </div>
    <svg class="w-4 h-4 text-shadow-600 transition-transform shrink-0 ml-4 {showConstitutionSection ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  {#if showConstitutionSection}
    <div class="border-t border-bark-300 p-5 space-y-4">
      {#if constitutionLoading}
        <div class="space-y-2">
          {#each Array(3) as _}
            <div class="h-16 rounded-lg bg-bark-200 animate-pulse"></div>
          {/each}
        </div>
      {:else}
        {#if constitutionError}
          <div class="px-3 py-2 rounded-lg border border-wilt-400 bg-wilt-50 text-sm text-wilt-700">
            {constitutionError}
          </div>
        {/if}

        <div class="space-y-3">
          <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Immutable Amendments</h3>
          {#each constitutionImmutableBlocks as block (block.id)}
            <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
              <div class="flex items-center justify-between mb-1.5">
                <span class="text-sm font-medium text-shadow-800">{block.title}</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-300 text-shadow-700">Read only</span>
              </div>
              <p class="text-sm text-shadow-700 leading-relaxed whitespace-pre-wrap">{block.content}</p>
            </div>
          {/each}

          {#if constitutionCompanionLayer}
            <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
              <div class="flex items-center justify-between mb-1.5">
                <span class="text-sm font-medium text-shadow-800">{constitutionCompanionLayer.title}</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-300 text-shadow-700">Derived</span>
              </div>
              <pre class="text-sm font-mono text-shadow-700 whitespace-pre-wrap bg-white/60 p-2 rounded border border-bark-200 max-h-48 overflow-y-auto">{constitutionCompanionLayer.content}</pre>
            </div>
          {/if}
        </div>

        <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Preview Output</h3>
            <span class="text-sm text-shadow-600">~{constitutionPreviewTokenCount} tokens</span>
          </div>
          <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-white/60 p-3 rounded border border-bark-200 max-h-64 overflow-y-auto leading-relaxed">{constitutionPreviewText}</pre>
        </div>

        <div class="rounded-lg border border-bark-300 bg-bark-50 p-3 text-sm text-shadow-700 leading-relaxed">
          Editable policy and runtime prompt layers belong in the composition stack, not inside Constitution Builder. This section is read-only by design except for direct file edits to the immutable source.
        </div>
      {/if}
    </div>
  {/if}
</div>
