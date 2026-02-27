<script lang="ts">
  let { message = 'Something went wrong', onRetry = undefined as (() => void) | undefined } = $props();
</script>

<div class="card-garden p-6 text-center">
  <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-wilt-50 dark:bg-wilt-900/20 mb-3">
    <svg class="w-6 h-6 text-wilt-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
    </svg>
  </div>
  <p class="text-sm text-wilt-600 dark:text-wilt-400">{message}</p>
  {#if onRetry}
    <button onclick={onRetry} class="mt-3 text-sm text-gold-600 hover:text-gold-700 dark:text-gold-400 dark:hover:text-gold-300 font-medium">
      Try again
    </button>
  {/if}
</div>
