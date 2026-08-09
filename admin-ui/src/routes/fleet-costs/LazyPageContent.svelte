<script lang="ts">
  import { page } from '$app/stores';
  import FleetCostUsage from '$lib/components/fleet/FleetCostUsage.svelte';
  import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';

  const companionScope = $derived(parseCompanionGardenScope($page.url.pathname));
</script>

{#if companionScope}
  <div class="garden-page space-y-5 pb-10">
    <GardenPageHeader
      eyebrow="Runtime & Tools · Cluster accounting"
      title="Cluster costs"
      description="Aggregated model usage is managed from the authorized cluster overview."
      class="border-b border-bark-300 pb-4"
    />
    <section class="garden-empty card-garden mx-auto max-w-2xl border-l-4 border-l-gold-400 p-8 text-center" aria-labelledby="fleet-costs-moved-heading">
      <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold-300 bg-gold-50 font-serif text-xl text-gold-700" aria-hidden="true">↗</span>
      <h2 id="fleet-costs-moved-heading" class="mt-4 font-serif text-2xl font-semibold text-shadow-900">Cluster costs moved</h2>
      <p class="mt-3 text-sm text-shadow-600">
        Cluster-wide usage and costs now live on the authorized cluster overview.
      </p>
      <a
        href="/fleet#fleet-costs"
        class="garden-action garden-action--primary mt-5 inline-flex rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white hover:bg-gold-700"
      >
        Open cluster usage and costs
      </a>
    </section>
  </div>
{:else}
  <div class="garden-page space-y-5 pb-10">
    <GardenPageHeader
      eyebrow="Runtime & Tools · Cluster accounting"
      title="Cluster costs"
      description="Aggregated model usage across registered companions, with one resolved calendar window and operator-visible attribution."
      class="border-b border-bark-300 pb-4"
    />
    <div class="[&>div]:!p-0 [&>div>header]:hidden">
      <FleetCostUsage />
    </div>
  </div>
{/if}
