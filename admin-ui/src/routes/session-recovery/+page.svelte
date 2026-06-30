<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listSessionRoutes,
    resetSourceChannelSession,
  } from '$lib/api/endpoints/sessions';
  import type {
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

  async function loadRoutes(): Promise<void> {
    loading = true;
    error = '';
    try {
      const data = await listSessionRoutes();
      routes = data.routes;
      channels = data.channels;
      if (!selectedSourceChannelId && data.routes[0]) {
        selectedSourceChannelId = data.routes[0].sourceChannelId;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load session routes';
    } finally {
      loading = false;
    }
  }

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

<main class="min-h-screen bg-moss-50 px-4 py-6 text-shadow-950">
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-5">
    <header class="flex flex-col gap-2 border-b border-moss-200 pb-4">
      <p class="text-xs font-semibold uppercase text-moss-700">Review & Safety</p>
      <h1 class="text-2xl font-semibold">Session Recovery</h1>
      <p class="max-w-3xl text-sm text-shadow-700">
        Start a fresh logical session for an existing source channel without deleting old L0 history.
        Future live context uses the new route; retained sessions stay available for explicit audit/search.
      </p>
    </header>

    {#if error}
      <div class="rounded border border-wilt-300 bg-wilt-50 px-4 py-3 text-sm text-wilt-800">
        {error}
      </div>
    {/if}

    {#if result}
      <div class="rounded border border-moss-300 bg-moss-100 px-4 py-3 text-sm text-moss-900">
        <p class="font-medium">{result.message}</p>
        <p class="mt-1 font-mono text-xs">
          {result.oldLogicalSessionId} -> {result.newLogicalSessionId}
        </p>
      </div>
    {/if}

    <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div class="rounded border border-moss-200 bg-white p-4 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">Active Routes</h2>
            <p class="text-sm text-shadow-600">{routes.length} routed source channel{routes.length === 1 ? '' : 's'}</p>
          </div>
          <button
            class="rounded border border-moss-300 px-3 py-2 text-sm font-medium text-moss-800 hover:bg-moss-50 disabled:opacity-50"
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
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-left text-sm">
              <thead class="border-b border-moss-200 text-xs uppercase text-shadow-600">
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
                  <tr class="border-b border-moss-100 align-top">
                    <td class="px-2 py-3">
                      <button
                        class="text-left font-mono text-xs text-moss-800 underline-offset-2 hover:underline"
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

      <form class="rounded border border-moss-200 bg-white p-4 shadow-sm" onsubmit={(event) => { event.preventDefault(); void resetSession(); }}>
        <h2 class="text-lg font-semibold">Start Fresh Lane</h2>
        <p class="mt-1 text-sm text-shadow-600">
          This retires the current active logical session for one physical source channel and creates a new live route.
        </p>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="source-channel">Source channel</label>
        <input
          id="source-channel"
          class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm"
          list="source-channel-options"
          bind:value={selectedSourceChannelId}
          placeholder="discord:channel-id"
        />
        <datalist id="source-channel-options">
          {#each sourceChannelOptions as channelId}
            <option value={channelId}>{channelLabel(channelId)}</option>
          {/each}
        </datalist>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="mode">Mode</label>
        <select id="mode" class="mt-1 w-full rounded border border-moss-300 px-3 py-2 text-sm" bind:value={mode}>
          <option value="break_glass_quarantine">Break-glass quarantine</option>
          <option value="fresh_split">Fresh split</option>
        </select>

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="actor">Actor</label>
        <input
          id="actor"
          class="mt-1 w-full rounded border border-moss-300 px-3 py-2 text-sm"
          bind:value={actor}
        />

        <label class="mt-4 block text-sm font-medium text-shadow-800" for="reason">Reason</label>
        <textarea
          id="reason"
          class="mt-1 min-h-24 w-full rounded border border-moss-300 px-3 py-2 text-sm"
          bind:value={reason}
          placeholder="Content poisoning, over-compressed context, bad live state, or other operator reason."
        ></textarea>

        {#if selectedRoute}
          <div class="mt-4 rounded border border-moss-200 bg-moss-50 p-3 text-xs text-shadow-700">
            <p><span class="font-semibold">Current active:</span> <span class="font-mono">{selectedRoute.activeLogicalSessionId}</span></p>
            <p class="mt-1"><span class="font-semibold">Retired sessions:</span> {selectedRoute.retiredSessions.length}</p>
          </div>
        {/if}

        <button
          class="mt-5 w-full rounded bg-wilt-700 px-4 py-2 text-sm font-semibold text-white hover:bg-wilt-800 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={loading || submitting}
        >
          {submitting ? 'Resetting...' : 'Create Fresh Logical Session'}
        </button>
      </form>
    </section>
  </div>
</main>
