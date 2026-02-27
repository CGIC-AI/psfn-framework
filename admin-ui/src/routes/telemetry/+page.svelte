<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getEvents, isConnected, startTelemetry, stopTelemetry, clearEvents } from '$lib/stores/telemetry.svelte';

  let events = $derived(getEvents());
  let connected = $derived(isConnected());

  onMount(() => {
    startTelemetry();
  });

  onDestroy(() => {
    stopTelemetry();
  });

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    });
  }

  function eventTypeColor(type: string): string {
    if (type.includes('error')) return 'text-wilt-600';
    if (type.includes('tool')) return 'text-gold-700';
    if (type.includes('stream') || type.includes('delta')) return 'text-moss-600';
    if (type.includes('memory')) return 'text-petal-500';
    return 'text-shadow-600';
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Sap</h1>
      <p class="text-shadow-400 text-sm mt-1">Real-time Events</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="flex items-center gap-1.5 text-xs">
        <span
          class="w-2 h-2 rounded-full"
          class:bg-moss-400={connected}
          class:bg-wilt-400={!connected}
        ></span>
        <span class="text-shadow-400">{connected ? 'Connected' : 'Disconnected'}</span>
      </span>
      <button
        onclick={clearEvents}
        class="px-3 py-1.5 rounded border border-bark-300 text-shadow-500 text-xs
               hover:bg-bark-200 transition-colors"
      >
        Clear
      </button>
    </div>
  </div>

  <div class="card overflow-hidden">
    <div class="max-h-[calc(100vh-14rem)] overflow-y-auto">
      {#if events.length === 0}
        <div class="p-8 text-center">
          <p class="text-shadow-400">Waiting for events...</p>
          <p class="text-shadow-300 text-xs mt-1">Events will appear here as they flow through the system</p>
        </div>
      {:else}
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-bark-100 border-b border-bark-300">
            <tr>
              <th class="text-left py-2 px-3 text-shadow-500 font-medium text-xs w-28">Time</th>
              <th class="text-left py-2 px-3 text-shadow-500 font-medium text-xs w-48">Type</th>
              <th class="text-left py-2 px-3 text-shadow-500 font-medium text-xs">Data</th>
            </tr>
          </thead>
          <tbody>
            {#each events as event, i (i)}
              <tr class="border-b border-bark-200 hover:bg-bark-100 transition-colors">
                <td class="py-1.5 px-3 text-xs text-shadow-400 font-mono tabular-nums">
                  {formatTimestamp(event.timestamp)}
                </td>
                <td class="py-1.5 px-3 text-xs font-mono {eventTypeColor(event.type)}">
                  {event.type}
                </td>
                <td class="py-1.5 px-3 text-xs text-shadow-500 font-mono truncate max-w-lg">
                  {typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
</div>
