<script lang="ts">
  // Fleet ICP posture (h248l.4): coarse inter-companion readiness for the
  // companions this session may reach. Counts cover only channels and pairs
  // whose members are all visible; no pair policy, reason text, or contact
  // detail ever reaches this component.
  import type { FleetPortalProjection } from '$lib/fleet/portal';
  import {
    describeFleetIcpCluster,
    describeFleetIcpCompanion,
    type FleetIcpTone,
  } from '$lib/fleet/icp-posture';

  interface Props {
    projection: FleetPortalProjection;
  }

  let { projection }: Props = $props();

  const cluster = $derived(describeFleetIcpCluster(projection.icp));

  function toneClass(tone: FleetIcpTone): string {
    if (tone === 'good') return 'bg-moss-50 text-moss-700 border-moss-200';
    if (tone === 'warn') return 'bg-gold-50 text-gold-700 border-gold-200';
    if (tone === 'bad') return 'bg-wilt-50 text-wilt-700 border-wilt-200';
    return 'bg-bark-100 text-shadow-600 border-bark-300';
  }
</script>

<section class="garden-section card-garden p-4" aria-labelledby="fleet-icp-heading">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div>
      <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Inter-companion</p>
      <h2 id="fleet-icp-heading" class="font-serif text-xl font-semibold text-shadow-900">ICP readiness</h2>
    </div>
    <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass(cluster.tone)}`}>
      Cluster {cluster.label}
    </span>
  </div>

  {#if projection.icp.activity.status === 'available'}
    <dl class="mt-3 grid grid-cols-3 gap-3 text-sm">
      <div>
        <dt class="text-xs uppercase tracking-wide text-shadow-500">Active channels</dt>
        <dd class="mt-1 font-medium tabular-nums text-shadow-900">
          {projection.icp.activity.activeChannels}{projection.icp.activity.activeChannelsTruncated ? '+' : ''}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-shadow-500">Messages (24h)</dt>
        <dd class="mt-1 font-medium tabular-nums text-shadow-900">{projection.icp.activity.deliveredTurns24h}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-shadow-500">Ready pairs</dt>
        <dd class="mt-1 font-medium tabular-nums text-shadow-900">{projection.icp.activity.readyPairs}</dd>
      </div>
    </dl>
  {:else if projection.icp.activity.status === 'unavailable'}
    <p class="mt-3 text-sm text-wilt-700">Shared coordination state is unreadable; activity counts are unavailable.</p>
  {:else}
    <p class="mt-3 text-sm text-shadow-600">ICP is inert until the fleet has two or more companions.</p>
  {/if}

  <ul class="mt-3 space-y-1 border-t border-bark-200 pt-3" aria-label="Companion ICP readiness">
    {#each projection.companions as companion (companion.companionId)}
      {@const posture = describeFleetIcpCompanion(companion.icp)}
      <li class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span class="truncate text-shadow-800">{companion.displayName}</span>
        <span class="flex items-center gap-2">
          <span class="text-xs text-shadow-500">{posture.detail}</span>
          <span class={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClass(posture.tone)}`}>
            {posture.label}
          </span>
        </span>
      </li>
    {/each}
  </ul>
</section>
