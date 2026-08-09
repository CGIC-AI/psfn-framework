<script lang="ts">
  let { groupId, size = 18 } = $props<{ groupId: string; size?: number }>();
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
  {#if groupId === 'operate'}
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  {:else if groupId === 'memory'}
    <path d="M12 22V8" />
    <path d="M7 12c-3 0-5-2-5-5 4 0 7 1 10 5" />
    <path d="M17 12c3 0 5-2 5-5-4 0-7 1-10 5" />
    <path d="M8 18c-2.5 0-4-1.5-4-4 3.5 0 6 1 8 4" />
  {:else if groupId === 'runtime'}
    <path d="M8.5 2h7l3.5 6-3.5 6h-7L5 8z" />
    <path d="M8 14v6h8v-6" />
    <path d="M9 8h6" />
  {:else if groupId === 'review'}
    <path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10" />
    <path d="m9 12 2 2 4-5" />
  {:else if groupId === 'cognitive-security'}
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    <path d="M12 14v3" />
  {:else}
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.36.3.58.73.6 1.2V10h1v4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
  {/if}
</svg>
