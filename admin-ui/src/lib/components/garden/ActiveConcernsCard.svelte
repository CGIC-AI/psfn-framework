<script lang="ts">
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import BoundedList from './BoundedList.svelte';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  let { class: className = '' } = $props<{ class?: string }>();

  // Read-only view over GET /api/admin/concerns (see
  // src/operator/garden/routes/concern-routes.ts). Mirrors the wire shape
  // of ActiveConcern in src/core/intention/concerns.ts.
  interface ActiveConcernView {
    id: string;
    text: string;
    priority: 'high' | 'medium' | 'low';
    source: string;
    status: string;
    createdAt: string;
    salience: number;
    contactId?: string;
    nextReviewAt?: string;
  }

  let concerns = $state<ActiveConcernView[]>([]);
  let loading = $state(true);
  let error = $state('');

  const PRIORITY_BADGE: Record<string, string> = {
    high: 'bg-wilt-50 text-wilt-700 border-wilt-300',
    medium: 'bg-gold-50 text-gold-700 border-gold-300',
    low: 'bg-bark-100 text-shadow-600 border-bark-300',
  };

  function priorityBadge(priority: string): string {
    return PRIORITY_BADGE[priority] ?? PRIORITY_BADGE.low;
  }

  function formatWhen(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleDateString();
  }

  onMount(async () => {
    try {
      const payload = await apiGet<{ concerns: ActiveConcernView[] }>('/api/admin/concerns?limit=25');
      concerns = payload.concerns;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load active concerns';
    } finally {
      loading = false;
    }
  });
</script>

<div class={`card-garden p-5 ${className}`.trim()}>
  <div class="flex items-center justify-between gap-3 mb-3">
    <h2 class="font-serif text-lg text-shadow-900">Active Concerns</h2>
    <a href={scopeGardenPath('/concerns')} class="text-sm font-medium text-gold-700 hover:text-gold-800">Manage Concerns</a>
  </div>
  {#if loading}
    <div class="animate-pulse space-y-2">
      <div class="h-5 rounded bg-bark-300"></div>
      <div class="h-5 w-3/4 rounded bg-bark-300"></div>
      <div class="h-5 w-1/2 rounded bg-bark-300"></div>
    </div>
  {:else if error}
    <p class="text-sm text-wilt-600">{error}</p>
  {:else if concerns.length === 0}
    <p class="text-sm text-shadow-600">No active concerns right now.</p>
  {:else}
    <BoundedList maxHeight="12rem" label="Active concerns">
      <ul class="space-y-2 pr-1">
        {#each concerns as concern (concern.id)}
          <li class="flex items-start gap-2">
            <span class="mt-0.5 inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-xs font-medium {priorityBadge(concern.priority)}">
              {concern.priority}
            </span>
            <span class="min-w-0">
              <span class="block truncate text-sm text-shadow-800" title={concern.text}>{concern.text}</span>
              <span class="block text-xs text-shadow-500">
                {concern.status} · salience {(concern.salience * 100).toFixed(0)}% · since {formatWhen(concern.createdAt)}
              </span>
            </span>
          </li>
        {/each}
      </ul>
    </BoundedList>
  {/if}
</div>
