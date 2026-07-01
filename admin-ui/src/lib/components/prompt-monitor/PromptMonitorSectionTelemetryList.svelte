<script lang="ts">
  import type { AdminAuthenticityProvenance, AdminPromptSectionTelemetry } from '$lib/types';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';

  interface Props {
    title: string;
    sections?: AdminPromptSectionTelemetry[];
    emptyText?: string;
  }

  let {
    title,
    sections = [],
    emptyText = 'No prompt section telemetry recorded.',
  }: Props = $props();

  function formatCount(value: number): string {
    return value.toLocaleString();
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

  function scopeTone(
    scopeClass: NonNullable<AdminPromptSectionTelemetry['scopeProvenance']>['scopeClass'],
  ): string {
    switch (scopeClass) {
      case 'dm':
        return 'border-gold-300 bg-gold-50 text-shadow-900';
      case 'room':
        return 'border-sky-300 bg-sky-50 text-sky-800';
      case 'global':
        return 'border-moss-300 bg-moss-50 text-moss-800';
      default:
        return 'border-bark-300 bg-bark-100 text-shadow-700';
    }
  }
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if sections.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each sections as section (`${section.id}-${section.title}`)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-shadow-900">{section.title}</p>
              <p class="mt-0.5 truncate font-mono text-xs text-shadow-600">{section.id}</p>
            </div>
            <p class="text-xs text-shadow-600">
              {formatCount(section.charCount)} chars . {formatCount(section.tokenCount)} tokens
            </p>
          </div>
          {#if section.scopeProvenance}
            <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {#if section.scopeProvenance.scopeKey}
                <span
                  class={`rounded-full border px-2 py-0.5 font-medium ${scopeTone(section.scopeProvenance.scopeClass)}`}
                  title={`Scope key: ${section.scopeProvenance.scopeKey}`}
                >
                  {section.scopeProvenance.scopeKey}
                </span>
              {/if}
              {#if section.scopeProvenance.producer}
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 font-mono text-shadow-700" title="Producer module">
                  {section.scopeProvenance.producer}
                </span>
              {/if}
              {#if section.scopeProvenance.volatility}
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 uppercase tracking-wide text-shadow-600">
                  {section.scopeProvenance.volatility.replace('_', ' ')}
                </span>
              {/if}
              {#if section.scopeProvenance.sourceHint}
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-shadow-600" title="Source data hint">
                  {section.scopeProvenance.sourceHint}
                </span>
              {/if}
            </div>
          {/if}
          {#if section.provenance}
            <div class="mt-3 flex flex-wrap gap-2 text-xs">
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                {formatProvenanceLabel(section.provenance)}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                {formatSafetyLabel(section.provenance)}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                detail loss: {section.provenance.detailLoss}
              </span>
              <span class="rounded border border-bark-300 bg-white px-2 py-0.5 text-shadow-700">
                emotion: {section.provenance.emotionalTexture}
              </span>
            </div>
          {/if}
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="Section Content"
              value={section.content}
              emptyText="No section content recorded."
              maxHeightClass="max-h-56"
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
