<script lang="ts">
  import ContextAllocationWidget from '$lib/components/garden/ContextAllocationWidget.svelte';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
</script>

<section aria-labelledby="context-allocation-heading" class="card-garden p-4 sm:p-5">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h2 id="context-allocation-heading" class="font-serif text-lg text-shadow-900">Context allocation</h2>
      <p class="mt-1 text-xs text-shadow-600">Active model window budget.</p>
    </div>
    <a href={scopeGardenPath('/settings')} class="whitespace-nowrap text-xs font-medium text-gold-700 hover:text-gold-800">
      Configure <span aria-hidden="true">→</span>
    </a>
  </div>
  <ContextAllocationWidget showVariants={false} class="mt-4" />
</section>
