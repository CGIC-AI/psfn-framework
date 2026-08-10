<script lang="ts">
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import BiographicalClaimsPanel from '../memory/BiographicalClaimsPanel.svelte';
</script>

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="Stable Biography"
    description="Review durable profile claims, exact source revisions, disclosure grants, and lifecycle reconciliation."
  />

  <div class="garden-section">
    <BiographicalClaimsPanel />
  </div>
</div>
