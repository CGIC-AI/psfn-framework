<script lang="ts">
  import type { FleetView } from '$lib/fleet/fleet-views';

  let { viewId, size = 18 } = $props<{ viewId: FleetView; size?: number }>();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if viewId === 'info'}
    <circle cx="12" cy="12" r="3" />
    <circle cx="5" cy="5" r="2" />
    <circle cx="19" cy="5" r="2" />
    <circle cx="12" cy="20" r="2" />
    <path d="m7 6 3 4m7-4-3 4m-1 5-.5 3" />
  {:else if viewId === 'attention'}
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  {:else if viewId === 'usage'}
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M8 17v-3" />
    <path d="M13 17V7" />
    <path d="M18 17v-7" />
  {:else if viewId === 'costs'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6.5v11" />
    <path d="M15 9c-.6-.9-1.7-1.4-3-1.4-1.6 0-2.9.8-2.9 2 0 2.7 5.9 1.4 5.9 4.1 0 1.2-1.3 2-3 2-1.3 0-2.4-.5-3-1.4" />
  {:else if viewId === 'lifecycle'}
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M19 8v6" />
    <path d="M16 11h6" />
  {:else}
    <path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10" />
  {/if}
</svg>
