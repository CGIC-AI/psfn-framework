<script lang="ts">
  import { onMount } from 'svelte';
  import {
    applyCogSecRemediation,
    listCogSecEvents,
    listSessionRoutes,
    previewCogSecRemediation,
    resetSourceChannelSession,
  } from '$lib/api/endpoints/sessions';
  import type {
    AdminCogSecEventListData,
    AdminCogSecRemediationApplyData,
    AdminCogSecRemediationInput,
    AdminCogSecRemediationPreviewData,
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
  let recoveryMode = $state<'fresh_lane' | 'cogsec'>('fresh_lane');
  let loading = $state(true);
  let submitting = $state(false);
  let error = $state('');
  let result = $state<AdminSessionRouteResetData | null>(null);
  let cogSecEvents = $state<AdminCogSecEventListData['events']>([]);
  let cogSecType = $state<AdminCogSecRemediationInput['type']>('content_poisoning');
  let cogSecSeverity = $state<AdminCogSecRemediationInput['severity']>('high');
  let cogSecLogicalSessionId = $state('');
  let cogSecMessageIds = $state('');
  let cogSecStartEntryId = $state('');
  let cogSecEndEntryId = $state('');
  let cogSecReason = $state('');
  let cogSecActor = $state('operator:garden');
  let cogSecCutEpoch = $state(true);
  let cogSecSubmitting = $state(false);
  let cogSecPreview = $state<AdminCogSecRemediationPreviewData | null>(null);
  let cogSecApplyResult = $state<AdminCogSecRemediationApplyData | null>(null);

  const sourceChannelOptions = $derived(
    [...new Set([
      ...routes.map(route => route.sourceChannelId),
      ...channels.map(channel => channel.channelId),
    ])].sort((left, right) => left.localeCompare(right)),
  );
  const selectedRoute = $derived(
    routes.find(route => route.sourceChannelId === selectedSourceChannelId) ?? null,
  );
  const selectedLogicalSessionId = $derived(
    cogSecLogicalSessionId.trim() || selectedRoute?.activeLogicalSessionId || selectedSourceChannelId,
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
      const cogSecData = await listCogSecEvents();
      routes = data.routes;
      channels = data.channels;
      cogSecEvents = cogSecData.events;
      if (!selectedSourceChannelId && data.routes[0]) {
        selectedSourceChannelId = data.routes[0].sourceChannelId;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load session routes';
    } finally {
      loading = false;
    }
  }

  function parseOptionalPositiveInteger(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
      throw new Error('Entry IDs must be positive integers.');
    }
    return parsed;
  }

  function parseMessageIds(value: string): number[] | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const ids = trimmed
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== part) {
          throw new Error('Message IDs must be comma-separated positive integers.');
        }
        return parsed;
      });
    return ids.length > 0 ? [...new Set(ids)] : undefined;
  }

  function buildCogSecInput(): AdminCogSecRemediationInput {
    const sourceChannelId = selectedSourceChannelId.trim();
    const logicalSessionId = selectedLogicalSessionId.trim();
    const reason = cogSecReason.trim();
    if (!sourceChannelId) throw new Error('Choose or enter a source channel.');
    if (!logicalSessionId) throw new Error('Logical session is required.');
    if (!reason) throw new Error('CogSec reason is required.');
    const messageIds = parseMessageIds(cogSecMessageIds);
    const startEntryId = parseOptionalPositiveInteger(cogSecStartEntryId);
    const endEntryId = parseOptionalPositiveInteger(cogSecEndEntryId);
    if (!messageIds?.length && startEntryId === undefined && endEntryId === undefined) {
      throw new Error('Enter message IDs or a start/end entry range.');
    }
    return {
      sourceChannelId,
      affectedLogicalSessionIds: [logicalSessionId],
      affectedMessageRanges: [{
        sourceChannelId,
        logicalSessionId,
        ...(messageIds ? { messageIds } : {}),
        ...(startEntryId !== undefined ? { startEntryId } : {}),
        ...(endEntryId !== undefined ? { endEntryId } : {}),
      }],
      type: cogSecType,
      severity: cogSecSeverity,
      reason,
      actor: cogSecActor.trim() || 'operator:garden',
      cutEpoch: cogSecCutEpoch,
    };
  }

  async function previewCogSec(): Promise<void> {
    cogSecSubmitting = true;
    error = '';
    cogSecApplyResult = null;
    try {
      cogSecPreview = await previewCogSecRemediation(buildCogSecInput());
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to preview CogSec remediation';
    } finally {
      cogSecSubmitting = false;
    }
  }

  async function applyCogSec(): Promise<void> {
    let input: AdminCogSecRemediationInput;
    try {
      input = buildCogSecInput();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Invalid CogSec remediation input';
      return;
    }
    const confirmed = window.confirm(
      `Apply CogSec remediation to ${input.sourceChannelId}? Selected companion L0 rows will be tombstoned, sealed evidence will be retained outside companion reach, and a fresh lane may be cut.`,
    );
    if (!confirmed) return;
    cogSecSubmitting = true;
    error = '';
    try {
      cogSecApplyResult = await applyCogSecRemediation(input);
      cogSecPreview = null;
      cogSecReason = '';
      const cogSecData = await listCogSecEvents();
      cogSecEvents = cogSecData.events;
      await loadRoutes();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to apply CogSec remediation';
    } finally {
      cogSecSubmitting = false;
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

    <div class="inline-flex w-fit overflow-hidden rounded border border-moss-300 bg-white text-sm shadow-sm">
      <button
        class={`px-4 py-2 font-medium ${recoveryMode === 'fresh_lane' ? 'bg-moss-700 text-white' : 'text-moss-800 hover:bg-moss-50'}`}
        type="button"
        onclick={() => { recoveryMode = 'fresh_lane'; }}
      >
        Fresh Lane
      </button>
      <button
        class={`border-l border-moss-300 px-4 py-2 font-medium ${recoveryMode === 'cogsec' ? 'bg-wilt-700 text-white' : 'text-moss-800 hover:bg-moss-50'}`}
        type="button"
        onclick={() => { recoveryMode = 'cogsec'; }}
      >
        CogSec
      </button>
    </div>

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

      {#if recoveryMode === 'fresh_lane'}
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
      {:else}
      <div class="flex flex-col gap-4">
        <form class="rounded border border-wilt-200 bg-white p-4 shadow-sm" onsubmit={(event) => { event.preventDefault(); void previewCogSec(); }}>
          <h2 class="text-lg font-semibold">CogSec Remediation</h2>
          <p class="mt-1 text-sm text-shadow-600">
            Seal selected companion L0 rows, replace them with tombstones, revoke derived cognition, and cut a fresh lane.
          </p>

          <label class="mt-4 block text-sm font-medium text-shadow-800" for="cogsec-source-channel">Source channel</label>
          <input
            id="cogsec-source-channel"
            class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm"
            list="source-channel-options"
            bind:value={selectedSourceChannelId}
            placeholder="discord:channel-id"
          />

          <label class="mt-4 block text-sm font-medium text-shadow-800" for="cogsec-logical-session">Logical session</label>
          <input
            id="cogsec-logical-session"
            class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm"
            bind:value={cogSecLogicalSessionId}
            placeholder={selectedRoute?.activeLogicalSessionId || selectedSourceChannelId || 'active logical session'}
          />

          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="block text-sm font-medium text-shadow-800" for="cogsec-type">
              Type
              <select id="cogsec-type" class="mt-1 w-full rounded border border-moss-300 px-3 py-2 text-sm" bind:value={cogSecType}>
                <option value="content_poisoning">Content poisoning</option>
                <option value="prompt_injection">Prompt injection</option>
                <option value="persona_poisoning">Persona poisoning</option>
                <option value="memory_poisoning">Memory poisoning</option>
                <option value="policy_drift">Policy drift</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label class="block text-sm font-medium text-shadow-800" for="cogsec-severity">
              Severity
              <select id="cogsec-severity" class="mt-1 w-full rounded border border-moss-300 px-3 py-2 text-sm" bind:value={cogSecSeverity}>
                <option value="high">High</option>
                <option value="critical">Critical</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>

          <label class="mt-4 block text-sm font-medium text-shadow-800" for="cogsec-message-ids">Message IDs</label>
          <input
            id="cogsec-message-ids"
            class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm"
            bind:value={cogSecMessageIds}
            placeholder="12, 13, 14"
          />

          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="block text-sm font-medium text-shadow-800" for="cogsec-start">
              Start entry
              <input id="cogsec-start" class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm" bind:value={cogSecStartEntryId} />
            </label>
            <label class="block text-sm font-medium text-shadow-800" for="cogsec-end">
              End entry
              <input id="cogsec-end" class="mt-1 w-full rounded border border-moss-300 px-3 py-2 font-mono text-sm" bind:value={cogSecEndEntryId} />
            </label>
          </div>

          <label class="mt-4 block text-sm font-medium text-shadow-800" for="cogsec-actor">Actor</label>
          <input
            id="cogsec-actor"
            class="mt-1 w-full rounded border border-moss-300 px-3 py-2 text-sm"
            bind:value={cogSecActor}
          />

          <label class="mt-4 block text-sm font-medium text-shadow-800" for="cogsec-reason">Reason</label>
          <textarea
            id="cogsec-reason"
            class="mt-1 min-h-24 w-full rounded border border-moss-300 px-3 py-2 text-sm"
            bind:value={cogSecReason}
            placeholder="Safe operator reason. Do not paste the poisoned content."
          ></textarea>

          <label class="mt-4 flex items-center gap-2 text-sm text-shadow-800">
            <input class="h-4 w-4 rounded border-moss-300" type="checkbox" bind:checked={cogSecCutEpoch} />
            Cut fresh lane after remediation
          </label>

          <div class="mt-5 grid gap-2 sm:grid-cols-2">
            <button
              class="rounded border border-moss-300 px-4 py-2 text-sm font-semibold text-moss-800 hover:bg-moss-50 disabled:cursor-not-allowed disabled:opacity-50"
              type="submit"
              disabled={loading || cogSecSubmitting}
            >
              {cogSecSubmitting ? 'Working...' : 'Preview Impact'}
            </button>
            <button
              class="rounded bg-wilt-700 px-4 py-2 text-sm font-semibold text-white hover:bg-wilt-800 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={loading || cogSecSubmitting}
              onclick={applyCogSec}
            >
              Apply CogSec
            </button>
          </div>
        </form>

        {#if cogSecPreview}
          <div class="rounded border border-moss-200 bg-white p-4 text-sm shadow-sm">
            <h3 class="font-semibold">Preview</h3>
            <p class="mt-1 font-mono text-xs text-shadow-700">{cogSecPreview.draft.caseId}</p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
              <p>L0 rows: <span class="font-semibold">{cogSecPreview.counts.l0Rows}</span></p>
              <p>Projection rows: <span class="font-semibold">{cogSecPreview.counts.projectionRows}</span></p>
              <p>Memories: <span class="font-semibold">{cogSecPreview.counts.memories}</span></p>
              <p>Embeddings: <span class="font-semibold">{cogSecPreview.counts.embeddingMemoryRows}</span></p>
              <p>Summaries: <span class="font-semibold">{cogSecPreview.counts.compactionSummaries}</span></p>
              <p>Gaps: <span class="font-semibold">{cogSecPreview.counts.lineageGaps}</span></p>
            </div>
          </div>
        {/if}

        {#if cogSecApplyResult}
          <div class="rounded border border-wilt-200 bg-wilt-50 p-4 text-sm text-wilt-900 shadow-sm">
            <h3 class="font-semibold">{cogSecApplyResult.message}</h3>
            <p class="mt-1 font-mono text-xs">{cogSecApplyResult.event.caseId}</p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
              <p>Tombstoned: <span class="font-semibold">{cogSecApplyResult.tombstones.reduce((sum, item) => sum + item.tombstonedL0RowCount, 0)}</span></p>
              <p>Revocation failures: <span class="font-semibold">{cogSecApplyResult.revocation.failures.length}</span></p>
              <p>Regeneration failures: <span class="font-semibold">{cogSecApplyResult.regeneration.failures.length}</span></p>
              <p>Fresh lane: <span class="font-semibold">{cogSecApplyResult.routeReset ? 'cut' : 'not cut'}</span></p>
            </div>
          </div>
        {/if}

        <div class="rounded border border-moss-200 bg-white p-4 text-sm shadow-sm">
          <h3 class="font-semibold">Safe CogSec Event Log</h3>
          {#if cogSecEvents.length === 0}
            <p class="mt-2 text-shadow-600">No CogSec events recorded.</p>
          {:else}
            <div class="mt-3 flex flex-col gap-2">
              {#each cogSecEvents.slice(0, 5) as event}
                <div class="rounded border border-moss-100 bg-moss-50 p-3">
                  <p class="font-mono text-xs">{event.caseId}</p>
                  <p class="mt-1 text-xs text-shadow-700">{event.type} / {event.severity} / {event.status}</p>
                  <p class="mt-1 text-xs text-shadow-700">
                    rows {event.tombstonedL0RowCount}; actions {event.actions.join(', ') || 'logged'}
                  </p>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      {/if}
    </section>
  </div>
</main>
