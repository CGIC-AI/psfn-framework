<script lang="ts">
  let {
    env,
  } = $props<{
    env: Record<string, unknown> | null | undefined;
  }>();
</script>

{#if env}
  <div class="card-garden px-5 py-4">
    <h2 class="text-sm font-serif font-semibold text-shadow-700 mb-2 uppercase tracking-wider">Environment</h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm text-shadow-700">
      {#if env.nodeVersion}
        <div>
          <span class="text-shadow-500">Node</span>
          <span class="font-mono ml-1 text-shadow-800">{env.nodeVersion}</span>
        </div>
      {/if}
      {#if env.platform}
        <div>
          <span class="text-shadow-500">Platform</span>
          <span class="font-mono ml-1 text-shadow-800">{env.platform}/{env.arch}</span>
        </div>
      {/if}
      {#if env.uptime !== undefined}
        <div>
          <span class="text-shadow-500">Uptime</span>
          <span class="ml-1 text-shadow-800">{Math.floor(Number(env.uptime) / 3600)}h {Math.floor((Number(env.uptime) % 3600) / 60)}m</span>
        </div>
      {/if}
      {#if env.memoryUsage && typeof env.memoryUsage === 'object'}
        {@const mem = env.memoryUsage as Record<string, number>}
        <div>
          <span class="text-shadow-500">Heap</span>
          <span class="ml-1 text-shadow-800">{(mem.heapUsed / 1_048_576).toFixed(0)}MB / {(mem.heapTotal / 1_048_576).toFixed(0)}MB</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
