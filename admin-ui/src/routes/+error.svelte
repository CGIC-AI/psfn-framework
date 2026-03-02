<script lang="ts">
  import { base } from '$app/paths';

  let { error, status } = $props<{
    error: Error & { message?: string };
    status: number;
  }>();

  function reloadPage() {
    window.location.reload();
  }
</script>

<svelte:head>
  <title>Garden Error</title>
</svelte:head>

<div class="min-h-screen bg-bark-100 px-4 py-8 sm:px-6 sm:py-12">
  <div class="mx-auto max-w-2xl card-garden p-6 sm:p-8">
    <div class="flex items-start gap-3">
      <svg class="w-6 h-6 text-wilt-600 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M12 9v3m0 4h.01m8.66 3H3.34c-1.3 0-2.11-1.4-1.46-2.5l8.66-14.5c.65-1.1 2.24-1.1 2.89 0l8.66 14.5c.65 1.1-.16 2.5-1.46 2.5z" />
      </svg>
      <div class="min-w-0">
        <h1 class="text-2xl font-serif font-bold text-shadow-900">A Branch Snapped In The Garden</h1>
        <p class="text-sm text-shadow-600 mt-1">The page hit an unexpected state. You can retry or return to the dashboard.</p>
      </div>
    </div>

    <div class="mt-5 rounded-lg border border-wilt-200 bg-wilt-50 px-4 py-3">
      <p class="text-sm text-shadow-700">
        <strong>Status:</strong> {status}
      </p>
      <p class="text-sm text-shadow-700 mt-1 break-words">
        <strong>Details:</strong> {error?.message || 'Unknown error'}
      </p>
    </div>

    <div class="mt-5 flex flex-wrap gap-2">
      <button
        onclick={reloadPage}
        class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 transition-colors"
      >
        Retry
      </button>
      <a
        href={`${base}/`}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-700 text-sm font-medium hover:bg-bark-100 transition-colors"
      >
        Return Home
      </a>
    </div>
  </div>
</div>
