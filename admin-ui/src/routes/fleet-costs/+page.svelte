<script lang="ts">
  import LazyGardenPage from '$lib/components/garden/LazyGardenPage.svelte';

  const loadPage = () => import('./LazyPageContent.svelte');
</script>

<LazyGardenPage
  loader={loadPage}
  loadingLabel="Loading fleet costs..."
  errorLabel="Failed to load fleet costs page."
/>
