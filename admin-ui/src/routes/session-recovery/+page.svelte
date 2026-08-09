<script lang="ts">
  // Fresh-lane session recovery. The CogSec redaction/remediation console that
  // used to live here as a second mode moved to Cognitive Security ->
  // Remediation (/cognitive-security/remediation) in htm9.11.
  import { onMount } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    listCogSecEvents,
    listSessionRoutes,
    resetSourceChannelSession,
  } from '$lib/api/endpoints/sessions';
  import { createSessionRecoveryInitialLoader } from './initial-loader';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import type {
    AdminCogSecEventListData,
    AdminSessionRouteResetData,
    AdminSessionRouteResetInput,
    AdminSessionRouteView,
    ChannelInfo,
  } from '$lib/types';

  let routes = $state<AdminSessionRouteView[]>([]);
  let channels = $state<ChannelInfo[]>([]);
  let selectedSourceChannelId = $state('');
  let reason = $state('');
  let actor = $state('operator:garden');
  let mode = $state<NonNullable<AdminSessionRouteResetInput['mode']>>('break_glass_quarantine');
  let loading = $state(true);
  let submitting = $state(false);
  let error = $state('');
  let result = $state<AdminSessionRouteResetData | null>(null);

  const sourceChannelOptions = $derived(
    [...new Set([
      ...routes.map(route => route.sourceChannelId),
      ...channels.map(channel => channel.channelId),
    ])].sort((left, right) => left.localeCompare(right)),
  );
  const selectedRoute = $derived(
    routes.find(route => route.sourceChannelId === selectedSourceChannelId) ?? null,
  );

  function formatDate(value: string | number | undefined): string {
    if (value === undefined) return 'never';
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestamp)) return String(value);
    return new Date(timestamp).toLocaleString();
  }

  function channelLabel(channelId: string): string {
    const channel = channels.find(item => item.channelId === channelId || item.sessionId === channelId);
    if (channel?.displayLabel) return `${channel.displayLabel} (${channelId})`;
    if (channel?.linkedContactName) return `${channel.linkedContactName} (${channelId})`;
    return channelId;
  }

  const loadRoutes = createSessionRecoveryInitialLoader<AdminSessionRouteView, ChannelInfo, AdminCogSecEventListData['events'][number]>({
    fetchRoutes: listSessionRoutes,
    fetchCogSecEvents: listCogSecEvents,
    getSelectedSourceChannelId: () => selectedSourceChannelId,
    onStart: () => {
      loading = true;
      error = '';
    },
    onRoutes: (data) => {
      routes = data.routes;
      channels = data.channels;
    },
    onCogSecEvents: () => {
      // CogSec events are surfaced on /cognitive-security pages now.
    },
    onSelectSourceChannelId: (sourceChannelId) => {
      selectedSourceChannelId = sourceChannelId;
    },
    onError: (message) => {
      error = message;
    },
    onSettled: () => {
      loading = false;
    },
  });

  onMount(() => {
    void loadRoutes();
  });

  async function resetSession(): Promise<void> {
    const sourceChannelId = selectedSourceChannelId.trim();
    const resetReason = reason.trim();
    if (!sourceChannelId) {
      error = 'Choose or enter a source channel.';
      return;
    }
    if (!resetReason) {
      error = 'Reason is required.';
      return;
    }
    const confirmed = window.confirm(
      `Start a fresh logical session for ${sourceChannelId}? Old L0 history stays retained for explicit audit/search.`,
    );
    if (!confirmed) return;

    submitting = true;
    error = '';
    result = null;
    try {
      result = await resetSourceChannelSession({
        sourceChannelId,
        reason: resetReason,
        actor: actor.trim() || 'operator:garden',
        mode,
      });
      reason = '';
      await loadRoutes();
      selectedSourceChannelId = sourceChannelId;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to reset session route';
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Session Recovery</title>
</svelte:head>

<div class="garden-page flex w-full flex-col gap-5">
    <GardenPageHeader
      eyebrow="Review & Safety · Session routing"
      title="Session Recovery"
      description="Cut a fresh logical lane without deleting prior L0 history. Retired sessions remain available for explicit audit and search."
    >
      {#snippet actions()}
        <a class="rounded-xl border border-bark-300 bg-surface px-3 py-2 text-sm font-medium text-shadow-700 shadow-sm transition-colors hover:border-gold-300 hover:text-shadow-900" href={scopeGardenPath('/cognitive-security/remediation')}>Open remediation</a>
      {/snippet}
    </GardenPageHeader>

    {#if error}
      <div class="garden-error rounded border border-wilt-300 bg-wilt-50 px-4 py-3 text-sm text-wilt-800">
        {error}
      </div>
    {/if}

    {#if result}
      <div class="garden-section rounded border border-moss-300 bg-moss-100 px-4 py-3 text-sm text-moss-900">
        <p class="font-medium">{result.message}</p>
        <p class="mt-1 font-mono text-xs">
          {result.oldLogicalSessionId} -> {result.newLogicalSessionId}
        </p>
      </div>
    {/if}

    <section class="garden-split-view grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div class="garden-section card-garden p-4">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-serif text-lg font-semibold text-shadow-900">Active Routes</h2>
            <p class="text-sm text-shadow-600">{routes.length} routed source channel{routes.length === 1 ? '' : 's'}</p>
          </div>
          <button
            class="rounded border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50"
            type="button"
            disabled={loading}
            onclick={loadRoutes}
          >
            Refresh
          </button>
        </div>

        {#if loading}
          <p class="text-sm text-shadow-600">Loading routes...</p>
        {:else if routes.length === 0}
          <p class="text-sm text-shadow-600">No source-channel routes have been created yet.</p>
        {:else}
          <div class="garden-table-shell garden-table-scroll overflow-x-auto rounded-xl border border-bark-200">
            <table class="garden-table w-full min-w-[760px] text-left text-sm">
              <thead class="border-b border-bark-200 text-xs uppercase text-shadow-600">
                <tr>
                  <th class="px-2 py-2 font-semibold">Source Channel</th>
                  <th class="px-2 py-2 font-semibold">Active Logical Session</th>
                  <th class="px-2 py-2 font-semibold">Generation</th>
                  <th class="px-2 py-2 font-semibold">Retired</th>
                  <th class="px-2 py-2 font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {#each routes as route}
                  <tr class="border-b border-bark-100 align-top">
                    <td class="px-2 py-3">
                      <button
                        class="text-left font-mono text-xs text-gold-700 underline-offset-2 hover:underline"
                        type="button"
                        onclick={() => { selectedSourceChannelId = route.sourceChannelId; }}
                      >
                        {route.sourceChannelId}
                      </button>
                    </td>
                    <td class="px-2 py-3 font-mono text-xs text-shadow-800">{route.activeLogicalSessionId}</td>
                    <td class="px-2 py-3">{route.routeGeneration}</td>
                    <td class="px-2 py-3">{route.retiredSessions.length}</td>
                    <td class="px-2 py-3">{formatDate(route.updatedAt)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      <form class="garden-section card-garden p-4" onsubmit={(event) => { event.preventDefault(); void resetSession(); }}>
        <h2 class="font-serif text-lg font-semibold text-shadow-900">Start Fresh Lane</h2>
        <p class="mt-1 text-sm text-shadow-600">
          This retires the current active logical session for one physical source channel and creates a new live route.
        </p>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="known-source-channel">Known source channel</label>
        <select
          id="known-source-channel"
          class="mt-1 w-full rounded border border-bark-300 px-3 py-2 font-mono text-sm"
          value={sourceChannelOptions.includes(selectedSourceChannelId) ? selectedSourceChannelId : ''}
          onchange={(event) => {
            if (event.currentTarget.value) selectedSourceChannelId = event.currentTarget.value;
          }}
        >
          <option value="">Choose from {sourceChannelOptions.length} known channel{sourceChannelOptions.length === 1 ? '' : 's'}</option>
          {#each sourceChannelOptions as channelId}
            <option value={channelId}>{channelLabel(channelId)}</option>
          {/each}
        </select>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="source-channel">Source channel ID</label>
        <input
          id="source-channel"
          class="mt-1 w-full rounded border border-bark-300 px-3 py-2 font-mono text-sm"
          bind:value={selectedSourceChannelId}
          placeholder="discord:channel-id"
        />

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="mode">Mode</label>
        <select id="mode" class="mt-1 w-full rounded border border-bark-300 px-3 py-2 text-sm" bind:value={mode}>
          <option value="break_glass_quarantine">Break-glass quarantine</option>
          <option value="fresh_split">Fresh split</option>
        </select>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="actor">Actor</label>
        <input
          id="actor"
          class="mt-1 w-full rounded border border-bark-300 px-3 py-2 text-sm"
          bind:value={actor}
        />

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="reason">Reason</label>
        <textarea
          id="reason"
          class="mt-1 min-h-24 w-full rounded border border-bark-300 px-3 py-2 text-sm"
          bind:value={reason}
          placeholder="Content poisoning, over-compressed context, bad live state, or other operator reason."
        ></textarea>

        {#if selectedRoute}
          <div class="mt-4 rounded border border-bark-200 bg-bark-50 p-3 text-xs text-shadow-700">
            <p><span class="font-semibold">Current active:</span> <span class="font-mono">{selectedRoute.activeLogicalSessionId}</span></p>
            <p class="mt-1"><span class="font-semibold">Retired sessions:</span> {selectedRoute.retiredSessions.length}</p>
          </div>
        {/if}

        <button
          class="mt-5 w-full rounded bg-wilt-600 px-4 py-2 text-sm font-semibold text-white hover:bg-wilt-700 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={loading || submitting}
        >
          {submitting ? 'Resetting...' : 'Create Fresh Logical Session'}
        </button>
      </form>
    </section>
</div>
