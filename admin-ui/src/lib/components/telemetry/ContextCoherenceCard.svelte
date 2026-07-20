<script lang="ts">
  import Sparkline from '$lib/components/accounting/charts/Sparkline.svelte';
  import type { TelemetryEvent } from '$lib/types';
  import {
    CONTEXT_COHERENCE_SIGNAL_LABELS,
    deriveContextCoherenceTelemetry,
  } from '$lib/telemetry/context-coherence';
  import { CONTEXT_COHERENCE_SIGNALS } from '../../../../../src/shared/contracts/context-coherence.js';

  let { events }: { events: TelemetryEvent[] } = $props();
  let model = $derived(deriveContextCoherenceTelemetry(events));

  function formatDuration(value: number | null): string {
    if (value === null) return 'unavailable';
    if (value < 1_000) return `${Math.round(value)} ms`;
    if (value < 60_000) return `${Math.round(value / 1_000)} sec`;
    if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
    return `${(value / 3_600_000).toFixed(1)} hr`;
  }
</script>

<section class="card-garden p-5" aria-labelledby="context-coherence-title">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 id="context-coherence-title" class="font-serif text-lg text-shadow-900">
        Context Coherence Canary
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        Deterministic confusion, looping, self-report, rumination, and operator-label telemetry.
      </p>
    </div>
    <div class="min-w-48 text-gold-600">
      <Sparkline
        values={model.trend}
        width={220}
        height={42}
        ariaLabel="Context coherence events by hour over the last 12 hours"
      />
      <p class="mt-1 text-right text-xs text-shadow-600">12-hour event trend</p>
    </div>
  </div>

  <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each CONTEXT_COHERENCE_SIGNALS as signal}
      <div class="rounded-lg border border-bark-200 bg-bark-50 px-3 py-2">
        <p class="text-xl font-serif text-shadow-900">{model.breakdown[signal]}</p>
        <p class="text-xs text-shadow-600">{CONTEXT_COHERENCE_SIGNAL_LABELS[signal]}</p>
      </div>
    {/each}
  </div>

  <div class="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-bark-200 pt-3 text-sm text-shadow-600">
    <span><strong class="text-shadow-800">{model.total}</strong> valid events cached</span>
    <span><strong class="text-shadow-800">{model.missingTurnCorrelatedCount}</strong> correlated with missing turns</span>
    <span><strong class="text-shadow-800">{model.groundTruthCount}</strong> operator-confirmed labels</span>
    {#if model.latest}
      <span>
        Latest context: {model.latest.context.recentMirrorNoteCount ?? 'unknown'} mirror notes ·
        {formatDuration(model.latest.context.timeGapMs)} gap ·
        {model.latest.context.activeConcernCount ?? 'unknown'} active concerns
      </span>
    {/if}
  </div>
</section>
