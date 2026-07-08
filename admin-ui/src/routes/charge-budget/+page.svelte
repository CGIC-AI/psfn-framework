<script lang="ts">
  import LazyGardenPage from '$lib/components/garden/LazyGardenPage.svelte';

  const loadPage = () => import('./LazyPageContent.svelte');
</script>

<LazyGardenPage
  loader={loadPage}
  loadingLabel="Loading charge budget..."
  errorLabel="Failed to load charge budget page."
/>
