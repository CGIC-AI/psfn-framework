<script lang="ts">
  import LazyGardenPage from '$lib/components/garden/LazyGardenPage.svelte';

  const loadPage = () => import('./LazyPageContent.svelte');
</script>

<svelte:head>
  <title>Settings · Garden</title>
</svelte:head>

<LazyGardenPage
  loader={loadPage}
  loadingLabel="Loading settings..."
  errorLabel="Failed to load settings page."
/>
