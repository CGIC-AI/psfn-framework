<script lang="ts">
  // Fleet Global Firewall tab (waw5q): the cluster-owned shared-gateway CogSec
  // posture. This surface is deliberately framed as the SHARED gateway's, not
  // the primary companion's — it presents the one intake-policy mode plus
  // content-free aggregate outcomes across the companions this session may
  // reach. An empty aggregate never means the firewall is off.

  import { onDestroy, onMount } from 'svelte';
  import {
    buildFleetCogSecOverview,
    fetchCompanionCogSecSnapshot,
    type CompanionCogSecSnapshot,
  } from '$lib/fleet/cogsec-overview';
  import type { FleetPortalProjection } from '$lib/fleet/portal';
  import type { FleetCogSecOverview } from '$lib/types';
  import FleetGlobalFirewallOverview from './FleetGlobalFirewallOverview.svelte';

  interface Props {
    projection: FleetPortalProjection;
  }

  let { projection }: Props = $props();

  let snapshots = $state<CompanionCogSecSnapshot[]>([]);
  let overview = $state<FleetCogSecOverview | null>(null);
  let loading = $state(true);
  let controller: AbortController | null = null;

  async function loadCogSec(): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    loading = true;
    try {
      const results = await Promise.all(
        projection.companions.map(companion => fetchCompanionCogSecSnapshot(companion, request.signal)),
      );
      if (controller !== request) return;
      snapshots = results;
      // The admin-ui does not carry the deployment access mode; frame by the
      // authorized companion count and keep the conservative multi-admin label
      // when more than one companion is reachable.
      const accessMode = results.filter(s => s.reachable).length > 1 ? 'multi_admin' : 'sole_admin';
      overview = buildFleetCogSecOverview(results, accessMode);
    } finally {
      if (controller === request) loading = false;
    }
  }

  onMount(() => { void loadCogSec(); });
  onDestroy(() => { controller?.abort(); controller = null; });

  const reachableCount = $derived(snapshots.filter(s => s.reachable).length);
</script>

<svelte:head>
  <title>Cluster · Global Firewall · Garden</title>
</svelte:head>

<div class="space-y-6">
  <header>
    <p class="text-xs font-semibold uppercase tracking-[0.22em] text-moss-700">
      Cluster-owned · Shared gateway
    </p>
    <h2 class="mt-1 font-serif text-2xl font-semibold text-shadow-900">Global Firewall</h2>
    <p class="mt-2 max-w-2xl text-sm text-shadow-600">
      The intake firewall is composed once in the shared gateway. This view owns its policy and
      content-free aggregate outcomes across the companions this session may reach — it is not any
      one companion's personal control.
    </p>
  </header>

  {#if loading && !overview}
    <section class="card-garden p-8" aria-busy="true">
      <p class="text-sm text-shadow-600">Loading shared firewall posture…</p>
    </section>
  {:else if overview}
    <FleetGlobalFirewallOverview {overview} reachableCount={reachableCount} />
  {/if}
</div>
