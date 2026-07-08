<script lang="ts">
  import type {
    AdminAuthenticityProvenance,
    AdminPromptSectionCacheability,
    AdminTurnPromptContextMessage,
  } from '$lib/types';

  interface Props {
    title: string;
    messages?: AdminTurnPromptContextMessage[];
    emptyText?: string;
    cacheability?: AdminPromptSectionCacheability | null;
  }

  let {
    title,
    messages = [],
    emptyText = 'No context messages recorded.',
    cacheability = null,
  }: Props = $props();

  function cacheabilityTone(value: AdminPromptSectionCacheability['cacheability'] | undefined): string {
    switch (value) {
      case 'append_only':
        return 'border-sky-300 bg-sky-50 text-sky-800';
      case 'static':
        return 'border-moss-300 bg-moss-50 text-moss-800';
      case 'session_stable':
        return 'border-gold-300 bg-gold-50 text-shadow-900';
      case 'volatile':
        return 'border-wilt-300 bg-wilt-50 text-wilt-800';
      default:
        return 'border-bark-300 bg-bark-100 text-shadow-700';
    }
  }

  function formatProvenanceLabel(provenance: AdminAuthenticityProvenance): string {
    return [
      provenance.kind.replaceAll('_', ' '),
      `source: ${provenance.sourceAuthor}`,
      `via: ${provenance.transformedBy}`,
      `wording: ${provenance.wording}`,
    ].join(' . ');
  }

  function formatSafetyLabel(provenance: AdminAuthenticityProvenance): string {
    return provenance.safeAsPartnerSpeech ? 'safe as partner speech' : 'not partner speech';
  }
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="font-medium text-shadow-900">{title}</h3>
    {#if cacheability}
      <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cacheabilityTone(cacheability.cacheability)}`}>
        {cacheability.cacheability.replace('_', ' ')}
      </span>
      {#each cacheability.cacheBreakers as breaker (breaker)}
        <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-xs text-shadow-700">
          {breaker.replace('_', ' ')}
        </span>
      {/each}
    {/if}
  </div>
  {#if cacheability}
    <p class="mt-1 text-xs text-shadow-600">{cacheability.reason}</p>
  {/if}
  {#if messages.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each messages as message, index (`${message.role}-${index}`)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-shadow-600">{message.role}</p>
          {#if message.provenance}
            <div class="mt-2 flex flex-wrap gap-2 text-xs">
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                {formatProvenanceLabel(message.provenance)}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                {formatSafetyLabel(message.provenance)}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                detail loss: {message.provenance.detailLoss}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                emotion: {message.provenance.emotionalTexture}
              </span>
            </div>
          {/if}
          <pre class="mt-2 overflow-auto whitespace-pre-wrap font-mono text-sm text-shadow-800">{message.content}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>
