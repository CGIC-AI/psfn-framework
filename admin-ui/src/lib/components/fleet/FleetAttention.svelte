<script lang="ts">
  import type { CompanionAttentionResult } from '$lib/fleet/attention-digest';

  interface Props {
    results: CompanionAttentionResult[];
    loading: boolean;
  }

  let { results, loading }: Props = $props();

  function formatTime(value: number | null): string {
    return value === null ? '—' : new Date(value).toLocaleString();
  }

  function entries(record: Record<string, number | undefined>): [string, number][] {
    return Object.entries(record)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .sort((left, right) => right[1] - left[1]);
  }
</script>

<section class="space-y-4" aria-label="What's broken across the cluster">
  {#if loading}
    <div class="card-garden p-6 text-sm text-shadow-600" aria-busy="true">Collecting each companion's attention digest…</div>
  {:else if results.length === 0}
    <div class="card-garden p-6 text-sm text-shadow-600">No companions are visible to this session.</div>
  {/if}

  {#each results as result (result.companionId)}
    <article class="card-garden p-4" aria-label={`Attention for ${result.displayName}`}>
      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="font-serif text-lg font-semibold text-shadow-900">{result.displayName}</h2>
        <span class="text-xs text-shadow-500">{result.companionId}</span>
      </header>

      {#if result.state !== 'ok'}
        <p class="mt-2 text-sm text-wilt-700" role="status">
          {result.state === 'denied' ? 'Not visible' : 'Unreachable'}: {result.reason}. This companion is not counted as healthy.
        </p>
      {:else}
        {@const digest = result.digest}
        <div class="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Open incidents</h3>
            {#if digest.incidents.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.incidents.error}</p>
            {:else if digest.incidents.open.length === 0}
              <p class="mt-1 text-sm text-moss-700">None open</p>
            {:else}
              <ul class="mt-1 space-y-1 text-sm">
                {#each digest.incidents.open as incident (incident.incidentId)}
                  <li class="text-wilt-700">
                    <span class="font-medium">{incident.family ?? incident.code}</span>
                    · {incident.severity} · {incident.component} · ×{incident.occurrenceCount}
                    · since {formatTime(incident.openedAtMs)}
                  </li>
                {/each}
              </ul>
            {/if}

            <h3 class="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Escalations</h3>
            {#if digest.escalations.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.escalations.error}</p>
            {:else}
              <p class="mt-1 text-sm {digest.escalations.counts.open > 0 ? 'text-wilt-700' : 'text-shadow-700'}">
                {digest.escalations.counts.open} open · {digest.escalations.counts.acknowledged} acknowledged
              </p>
            {/if}

            <h3 class="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Degraded subsystems</h3>
            {#if digest.subsystems.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.subsystems.error}</p>
            {:else if digest.subsystems.attention.length === 0}
              <p class="mt-1 text-sm text-moss-700">All lanes healthy</p>
            {:else}
              <ul class="mt-1 space-y-1 text-sm">
                {#each digest.subsystems.attention as lane (lane.id)}
                  <li class="text-wilt-700">{lane.label}: {lane.status}{lane.lastReason ? ` (${lane.lastReason})` : ''}</li>
                {/each}
              </ul>
            {/if}
          </div>

          <div>
            <h3 class="text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Exhausted deferred actions</h3>
            {#if digest.deferredActions.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.deferredActions.error}</p>
            {:else}
              <p class="mt-1 text-sm text-shadow-700">
                {digest.deferredActions.failedCount} failed · {digest.deferredActions.permanentRejectCount} rejected ·
                {digest.deferredActions.retryScheduledCount} retrying (since agent start)
              </p>
              {#each digest.deferredActions.recentFailures as failure (`${failure.actionKind}:${failure.failedAt}`)}
                <p class="text-xs text-wilt-700">{failure.actionKind} · {failure.reason} · attempt {failure.attempt}/{failure.maxAttempts} · {formatTime(failure.failedAt)}</p>
              {/each}
            {/if}

            <h3 class="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Model-call failures today</h3>
            {#if digest.modelCalls.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.modelCalls.error}</p>
            {:else}
              <p class="mt-1 text-sm text-shadow-700">{digest.modelCalls.failedCalls} of {digest.modelCalls.totalCalls} calls failed (preemptions count as failures)</p>
              {#each digest.modelCalls.failuresByClassAndOrigin as group (`${group.runtimeLaneClass}:${group.originStage}`)}
                <p class="text-xs text-shadow-600">{group.runtimeLaneClass} · {group.originStage}: {group.failedCalls}</p>
              {/each}
            {/if}

            <h3 class="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">Proactivity</h3>
            {#if digest.proactivity.state === 'unavailable'}
              <p class="mt-1 text-sm text-wilt-700">Unavailable: {digest.proactivity.error}</p>
            {:else}
              {#if digest.proactivity.feltImpulses}
                <p class="mt-1 text-sm text-shadow-700">
                  Impulses qualified {digest.proactivity.feltImpulses.qualified} · candidates {digest.proactivity.feltImpulses.candidateLinks}
                  · delivered {digest.proactivity.feltImpulses.lifecycle.delivered} · suppressed {digest.proactivity.feltImpulses.lifecycle.suppressed}
                </p>
              {/if}
              {#if digest.proactivity.outreach}
                <p class="mt-1 text-sm text-shadow-700">
                  Outreach (recent): {#each entries(digest.proactivity.outreach.byPhase) as [phase, count] (phase)}<span class="mr-2">{phase} {count}</span>{/each}
                </p>
                {#each entries(digest.proactivity.outreach.suppressedByReason) as [reason, count] (reason)}
                  <p class="text-xs text-shadow-600">suppressed · {reason}: {count}</p>
                {/each}
              {/if}
              {#if !digest.proactivity.feltImpulses && !digest.proactivity.outreach}
                <p class="mt-1 text-sm text-shadow-600">No proactivity records</p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </article>
  {/each}
</section>
