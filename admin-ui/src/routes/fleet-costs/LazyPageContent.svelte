<script lang="ts">
  import { page } from '$app/stores';
  import FleetCostUsage from '$lib/components/fleet/FleetCostUsage.svelte';
  import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';

  const companionScope = $derived(parseCompanionGardenScope($page.url.pathname));
</script>

{#if companionScope}
  <section class="p-4 sm:p-6 lg:p-8" aria-labelledby="fleet-costs-moved-heading">
    <div class="card-garden mx-auto max-w-2xl p-8">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-gold-700">Fleet accounting</p>
      <h1 id="fleet-costs-moved-heading" class="mt-1 font-serif text-3xl font-semibold text-shadow-900">
        Fleet costs moved
      </h1>
      <p class="mt-3 text-sm text-shadow-600">
        Fleet-wide usage and costs now live on the authorized fleet overview.
      </p>
      <a
        href="/fleet#fleet-costs"
        class="mt-5 inline-flex rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white hover:bg-gold-700"
      >
        Open fleet usage and costs
      </a>
    </div>
  </section>
{:else}
  <FleetCostUsage />
{/if}
