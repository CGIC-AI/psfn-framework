<script lang="ts">
  import type { ContactChannelLink } from '$lib/types';

  let { link }: { link: ContactChannelLink } = $props();
  const details = $derived([
    ...(link.introducedVia ? [`via ${link.introducedVia}`] : []),
    ...(link.introducedAtWorld ? [`World ${link.introducedAtWorld}`] : []),
    ...(link.introducedAtPlaceId ? [`Place ${link.introducedAtPlaceId}`] : []),
  ]);
</script>

{#if details.length > 0}
  <p class="mt-0.5 text-xs text-shadow-600" data-contact-introduction-provenance>
    Introduced {details.join(' · ')}
  </p>
{/if}
