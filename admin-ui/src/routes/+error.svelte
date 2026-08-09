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

<main class="grid min-h-[70dvh] place-items-center px-4 py-10 sm:px-6">
  <section class="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_20px_60px_rgb(38_35_30/0.09)]">
    <div class="border-b border-line bg-sunken px-6 py-7 sm:px-8">
      <div class="flex items-start gap-4">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-wilt-300 bg-wilt-50 text-wilt-700" aria-hidden="true">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 9v3m0 4h.01m8.66 3H3.34c-1.3 0-2.11-1.4-1.46-2.5l8.66-14.5c.65-1.1 2.24-1.1 2.89 0l8.66 14.5c.65 1.1-.16 2.5-1.46 2.5z" />
          </svg>
        </span>
        <div class="min-w-0">
          <p class="page-kicker">Garden · Recovery</p>
          <h1 class="page-title mt-1">A branch snapped in the Garden</h1>
          <p class="page-description mt-2">This view reached an unexpected state. Retry it safely or return to the dashboard.</p>
        </div>
      </div>
    </div>

    <div class="px-6 py-6 sm:px-8">
      <dl class="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-[8rem_1fr]">
        <dt class="bg-sunken px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted">Status</dt>
        <dd class="bg-surface px-4 py-3 font-mono text-sm text-ink">{status}</dd>
        <dt class="bg-sunken px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted">Details</dt>
        <dd class="break-words bg-surface px-4 py-3 text-sm text-ink">{error?.message || 'Unknown error'}</dd>
      </dl>

      <div class="mt-6 flex flex-wrap gap-2">
        <button onclick={reloadPage} class="garden-action garden-action--primary">
          Retry view
        </button>
        <a href={`${base}/`} class="garden-action">
          Return to dashboard
        </a>
      </div>
    </div>
  </section>
</main>
