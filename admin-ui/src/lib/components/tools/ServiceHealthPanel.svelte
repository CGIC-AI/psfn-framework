<script lang="ts">
  import type { RuntimeServiceHealth } from '$lib/types/tools';
  import FailureRow from './FailureRow.svelte';
  import {
    availableActionSummary,
    formatTimestamp,
    HEALTH_BADGE,
    HEALTH_LABELS,
    SERVICE_LABELS,
  } from './tool-display';

  interface Props {
    service: RuntimeServiceHealth;
  }

  let { service }: Props = $props();

  const actionSummary = $derived(availableActionSummary(service));
</script>

<article class="card-garden p-5">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold uppercase tracking-[0.16em] text-shadow-500">
        {SERVICE_LABELS[service.serviceId]}
      </h3>
      <p class="mt-1 text-xs text-shadow-500">Checked {formatTimestamp(service.checkedAt)}</p>
    </div>
    <span class="rounded-full border px-2.5 py-1 text-xs font-medium {HEALTH_BADGE[service.status]}">
      {HEALTH_LABELS[service.status]}
    </span>
  </div>
  <p class="mt-4 text-sm leading-relaxed text-shadow-700">{service.detail}</p>

  {#if actionSummary}
    <p class="mt-3 rounded-xl border border-bark-200 bg-bark-50 px-3 py-2 text-xs text-shadow-700">
      {actionSummary}
    </p>
  {/if}

  {#if service.lastFailure}
    <div class="mt-4">
      <FailureRow
        title="Last failure"
        message={service.lastFailure.message}
        timestamp={service.lastFailure.at}
      />
    </div>
  {/if}
</article>
