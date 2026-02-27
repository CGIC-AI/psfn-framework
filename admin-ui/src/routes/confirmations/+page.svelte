<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getConfirmations, resolveConfirmation } from '$lib/api/endpoints/confirmations';
  import type { ConfirmationQueueEntry, ConfirmationDecision } from '$lib/types';

  // ── State ──
  let entries = $state<ConfirmationQueueEntry[]>([]);
  let available = $state(true);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  let actionMessage = $state('');
  let actionIsError = $state(false);

  // Track modified params per entry
  let modifiedParams = $state<Record<string, string>>({});

  function formatTimestamp(value: number): string {
    return new Date(value).toLocaleString();
  }

  function stringifyParams(params: Record<string, unknown>): string {
    try {
      return JSON.stringify(params, null, 2);
    } catch {
      return '{}';
    }
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;

    try {
      const data = await getConfirmations();
      entries = data.entries;
      available = data.available;
      if (data.message) {
        actionMessage = data.message;
      }
      // Initialize modified params for new entries
      for (const entry of data.entries) {
        if (!modifiedParams[entry.id]) {
          modifiedParams[entry.id] = stringifyParams(entry.params);
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load confirmations';
      }
    } finally {
      loading = false;
    }
  }

  async function handleResolve(id: string, decision: ConfirmationDecision) {
    actionMessage = '';
    actionIsError = false;

    let resolveModifiedParams: Record<string, unknown> | undefined;
    if (decision === 'modify') {
      const raw = modifiedParams[id]?.trim();
      if (!raw) {
        actionMessage = 'Modified params JSON is required for modify.';
        actionIsError = true;
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          actionMessage = 'Modified params must be a JSON object.';
          actionIsError = true;
          return;
        }
        resolveModifiedParams = parsed as Record<string, unknown>;
      } catch {
        actionMessage = 'Invalid JSON in modified params.';
        actionIsError = true;
        return;
      }
    }

    try {
      const result = await resolveConfirmation(id, decision, resolveModifiedParams);
      if (result.ok) {
        actionMessage = result.message || `Confirmation ${decision}d successfully.`;
        actionIsError = false;
      } else {
        actionMessage = result.message || `Failed to ${decision} confirmation.`;
        actionIsError = true;
      }
      // Reload after action
      await loadData();
    } catch (e) {
      actionMessage = e instanceof Error ? e.message : 'Action failed';
      actionIsError = true;
    }
  }

  // ── Auto-refresh every 15s ──
  let refreshInterval: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    loadData();
    refreshInterval = setInterval(loadData, 15_000);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Gate</h1>
      <p class="text-sm text-shadow-600 mt-1">Pending approval queue -- review, approve, deny, or modify actions</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xs text-shadow-600">Auto-refreshes every 15s</span>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
               text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  <!-- Action message -->
  {#if actionMessage}
    <div class="card-garden p-4 border-l-4 {actionIsError ? 'border-l-wilt-400' : 'border-l-moss-400'}">
      <p class="text-sm {actionIsError ? 'text-wilt-600' : 'text-moss-700'}">{actionMessage}</p>
    </div>
  {/if}

  {#if loading && entries.length === 0}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading confirmation queue...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-bark-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="text-sm text-shadow-800">
            Requires gateway connection
          </p>
          <p class="text-sm text-shadow-600 mt-2">
            The confirmation queue is available when the agent is running with an active gateway.
            Actions needing approval are queued by the gateway policy engine when agent requests
            exceed workspace boundaries or touch sensitive resources.
          </p>
        </div>
      </div>
    </div>

    <!-- Explanation of the system -->
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">How Confirmations Work</h2>
      <div class="space-y-3 text-sm text-shadow-700">
        <p>When the agent requests an action that requires approval (e.g., accessing files outside the workspace, executing privileged operations), the gateway queues it here instead of executing immediately.</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Approve</p>
            <p>Execute the action as-is with the original parameters.</p>
          </div>
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Modify</p>
            <p>Edit the parameters JSON and execute with modified values.</p>
          </div>
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Deny</p>
            <p>Reject the action. The agent receives a denial response.</p>
          </div>
        </div>
      </div>
    </div>
  {:else if !available}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">Gateway not connected</p>
      <p class="text-sm text-shadow-600">Confirmations require an active gateway connection. The approval queue will appear here when the agent is running with the gateway.</p>
    </div>
  {:else if entries.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No pending confirmations</p>
      <p class="text-sm text-shadow-600">All clear. Actions needing approval will appear here automatically.</p>
    </div>
  {:else}
    <!-- Intro text -->
    <div class="card-garden p-4">
      <p class="text-sm text-shadow-700">
        Actions requiring approval are queued here. Approve, deny, or modify parameters before execution.
      </p>
    </div>

    <!-- Confirmation entries -->
    <div class="space-y-4">
      {#each entries as entry (entry.id)}
        <div class="card-garden overflow-hidden">
          <!-- Entry header -->
          <div class="px-5 py-4 border-b border-bark-100 bg-bark-50">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-base font-semibold text-shadow-900">
                  {entry.method}
                  <span class="text-shadow-600 font-normal">({entry.action})</span>
                </h3>
              </div>
              <span class="inline-block px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700">
                Pending
              </span>
            </div>
          </div>

          <div class="px-5 py-4 space-y-4">
            <!-- Metadata -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <span class="text-shadow-600">ID:</span>
                <code class="ml-1 font-mono text-shadow-800 bg-bark-100 px-1.5 py-0.5 rounded">{entry.id}</code>
              </div>
              <div>
                <span class="text-shadow-600">Scope:</span>
                <span class="ml-1 text-shadow-800">{entry.scope}</span>
              </div>
              <div>
                <span class="text-shadow-600">Requested:</span>
                <span class="ml-1 text-shadow-800">{formatTimestamp(entry.requestedAt)}</span>
              </div>
              <div>
                <span class="text-shadow-600">Expires:</span>
                <span class="ml-1 text-shadow-800">{formatTimestamp(entry.expiresAt)}</span>
              </div>
              <div class="md:col-span-2">
                <span class="text-shadow-600">Reason:</span>
                <span class="ml-1 text-shadow-800">{entry.companionReason}</span>
              </div>
            </div>

            <!-- Parameters -->
            <div>
              <label for="params-{entry.id}" class="block text-sm font-medium text-shadow-700 mb-1">
                Parameters (editable for Modify)
              </label>
              <textarea
                id="params-{entry.id}"
                bind:value={modifiedParams[entry.id]}
                rows="4"
                class="w-full text-sm font-mono p-3 rounded-lg border border-bark-300
                       bg-bark-50 text-shadow-800 focus:border-gold-400 focus:outline-none
                       focus:ring-1 focus:ring-gold-200 resize-y"
              ></textarea>
            </div>

            <!-- Action buttons -->
            <div class="flex gap-3 pt-2">
              <button
                onclick={() => handleResolve(entry.id, 'approve')}
                class="px-4 py-2 rounded-lg text-sm font-medium
                       bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors
                       border border-moss-300"
              >
                Approve
              </button>
              <button
                onclick={() => handleResolve(entry.id, 'deny')}
                class="px-4 py-2 rounded-lg text-sm font-medium
                       bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors
                       border border-wilt-200"
              >
                Deny
              </button>
              <button
                onclick={() => handleResolve(entry.id, 'modify')}
                class="px-4 py-2 rounded-lg text-sm font-medium
                       bg-gold-100 text-gold-700 hover:bg-gold-200 transition-colors
                       border border-gold-300"
              >
                Modify
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
