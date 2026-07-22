<script lang="ts">
  import LazyGardenPage from '$lib/components/garden/LazyGardenPage.svelte';

  const loadPage = () => import('./LazyPageContent.svelte');
</script>

<LazyGardenPage
  loader={loadPage}
  loadingLabel="Loading cluster costs..."
  errorLabel="Failed to load cluster costs page."
/>
