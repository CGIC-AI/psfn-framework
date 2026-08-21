<script lang="ts">
  import type { AdminDashboardData } from '$lib/types';

  type Routing = AdminDashboardData['stats']['intentionFollowUpRouting'];
  type Evidence = Routing['handoff'];

  let { routing } = $props<{ routing: Routing }>();

  const evidenceRows = $derived([routing.handoff, routing.scheduled]);
  const observedAtIso = $derived(new Date(routing.observedAtMs).toISOString());

  function formatHorizon(value: number | null): string {
    if (value === null) return 'Runtime horizon unavailable';
    const dayMs = 24 * 60 * 60 * 1_000;
    const hourMs = 60 * 60 * 1_000;
    if (value % dayMs === 0) {
      const days = value / dayMs;
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    if (value % hourMs === 0) {
      const hours = value / hourMs;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${value.toLocaleString()} ms`;
  }

  function evidenceLabel(evidence: Evidence): string {
    return evidence.disposition === 'handoff' ? 'Handoff' : 'Scheduled';
  }

  function reasonLabel(evidence: Evidence): string {
    return evidence.reason === 'active_pending_follow_up'
      ? 'Active pending follow-up store'
      : 'Pending intention scheduler records';
  }

  function countLabel(evidence: Evidence): string {
    if (!evidence.available || evidence.observedCount === null) return 'Evidence unavailable';
    return `${evidence.observedCount.toLocaleString()}${evidence.atReadLimit ? '+' : ''} observed`;
  }

  function dueAtIso(evidence: Evidence): string | null {
    return evidence.earliestDueAtMs === null
      ? null
      : new Date(evidence.earliestDueAtMs).toISOString();
  }
</script>

<section class="card-garden p-4" aria-labelledby="intention-routing-heading">
  <p class="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Runtime policy and evidence</p>
  <h2 id="intention-routing-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">
    Intention routing
  </h2>
  <div class="mt-3 rounded-lg border border-bark-200 bg-bark-50 px-3 py-2.5">
    <p class="text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Near-term horizon</p>
    <p class="mt-1 font-serif text-xl text-shadow-900">{formatHorizon(routing.nearTermHorizonMs)}</p>
    <p class="mt-1 text-xs text-shadow-500">
      {routing.horizonSource === 'effective_scheduler_config'
        ? 'Effective scheduler runtime'
        : 'Effective scheduler state was not supplied'}
    </p>
  </div>

  <dl class="mt-3 space-y-2">
    {#each evidenceRows as evidence (evidence.disposition)}
      {@const dueAt = dueAtIso(evidence)}
      <div class="rounded-lg border border-bark-200 px-3 py-2.5">
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-sm font-semibold text-shadow-800">{evidenceLabel(evidence)}</dt>
          <dd class="text-sm tabular-nums text-shadow-700">{countLabel(evidence)}</dd>
        </div>
        <dd class="mt-1 text-xs text-shadow-500">{reasonLabel(evidence)}</dd>
        {#if dueAt}
          <dd class="mt-1 text-xs text-shadow-600">
            Earliest due <time datetime={dueAt} class="font-mono">{dueAt}</time>
          </dd>
        {:else if evidence.available}
          <dd class="mt-1 text-xs text-shadow-500">No explicit due time in the observed window.</dd>
        {/if}
      </div>
    {/each}
  </dl>

  <p class="mt-3 text-[11px] leading-relaxed text-shadow-500">
    Observed <time datetime={observedAtIso} class="font-mono">{observedAtIso}</time>.
    Bounded to {routing.evidenceLimit.toLocaleString()} records per source. Counts and due times only.
  </p>
</section>
