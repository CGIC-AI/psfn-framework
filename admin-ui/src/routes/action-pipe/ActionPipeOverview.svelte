<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';

  let { status }: { status: ActionPipeStatus } = $props();
</script>

<section class="grid gap-4 md:grid-cols-4" aria-label="Action pipe overview">
  <div class="card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Queue Depth</p>
    <p class="mt-3 text-4xl font-serif font-bold text-shadow-900">{status.queueDepth}</p>
    <p class="mt-2 text-sm text-shadow-600">{status.availableSlots} available of {status.maxQueueDepth} total slots.</p>
  </div>
  <div class="card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Ready / Running</p>
    <p class="mt-3 text-4xl font-serif font-bold text-gold-600">{status.readyCount + status.runningCount}</p>
    <p class="mt-2 text-sm text-shadow-600">{status.readyCount} ready, {status.runningCount} running now.</p>
  </div>
  <div class="card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Failures</p>
    <p class="mt-3 text-4xl font-serif font-bold text-wilt-600">{status.failures.failedCount}</p>
    <p class="mt-2 text-sm text-shadow-600">{status.failures.recentFailures.length} recent retained failure records.</p>
  </div>
  <div class="card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Persistence</p>
    <p class="mt-3 text-2xl font-serif font-bold text-shadow-900">{status.persistence.loadState}</p>
    <p class="mt-2 text-sm text-shadow-600">{status.persistence.enabled ? 'Queue persistence enabled.' : 'Queue persistence not configured.'}</p>
  </div>
</section>
