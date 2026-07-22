<script lang="ts">
  import { onMount } from 'svelte';
  import {
    acknowledgeActionPipeAction,
    cancelActionPipeAction,
    getActionPipeStatus,
    type ActionPipeStatus,
  } from '$lib/api/endpoints/action-pipe';
  import ActionPipeOverview from './ActionPipeOverview.svelte';
  import ActionPipeLanes from './ActionPipeLanes.svelte';
  import ActionPipeQueue from './ActionPipeQueue.svelte';
  import ActionPipePersistence from './ActionPipePersistence.svelte';
  import ActionPipeOutreach from './ActionPipeOutreach.svelte';
  import ActionPipeHistory from './ActionPipeHistory.svelte';
  import ActionPipeSubagents from './ActionPipeSubagents.svelte';

  type QueuedAction = ActionPipeStatus['queued'][number];
  type FailureRecord = ActionPipeStatus['failures']['recentFailures'][number];
  type DropRecord = ActionPipeStatus['backPressure']['recentDrops'][number];
  type TerminalRecord = ActionPipeStatus['terminal']['recentTerminals'][number];
  type CompletionRecord = ActionPipeStatus['completions']['recentCompletions'][number];
  type HistoryRecord = FailureRecord | DropRecord | TerminalRecord | CompletionRecord;

  const MUTATION_CANCEL_DETAIL = 'Cancelled from Garden action-pipe operator surface.';
  const MUTATION_ACK_DETAIL = 'Acknowledged from Garden action-pipe operator surface.';

  let status = $state<ActionPipeStatus | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let mutationMessage = $state('');
  let mutationOk = $state(true);
  let mutatingActionRef = $state('');

  let queuedActions = $derived(status?.queued ?? []);
  let lanes = $derived(status?.lanes ?? []);
  let recentFailures = $derived(status?.failures.recentFailures ?? []);
  let recentDrops = $derived(status?.backPressure.recentDrops ?? []);
  let recentTerminals = $derived(status?.terminal.recentTerminals ?? []);
  let recentCompletions = $derived(status?.completions.recentCompletions ?? []);
  let outreachRecords = $derived(status?.outreachOutbox?.recentRecords ?? []);
  let subagentOutcomes = $derived.by(() => recentCompletions.filter((entry) => Boolean(entry.subagentSpawn)));
  let historyPanels = $derived.by(() => [
    { title: 'Failures', records: recentFailures as HistoryRecord[], empty: 'No recent failures.' },
    { title: 'Back-pressure drops', records: recentDrops as HistoryRecord[], empty: 'No recent back-pressure drops.' },
    { title: 'Operator terminals', records: recentTerminals as HistoryRecord[], empty: 'No recent cancellations or acknowledgements.' },
    { title: 'Completions', records: recentCompletions as HistoryRecord[], empty: 'No recent completions.' },
  ]);

  async function loadStatus(): Promise<void> {
    errorMessage = '';
    mutationMessage = '';
    try {
      status = await getActionPipeStatus();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load action pipe status.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshStatus(): Promise<void> {
    refreshing = true;
    await loadStatus();
  }

  async function cancelAction(action: QueuedAction): Promise<void> {
    mutatingActionRef = action.actionId;
    mutationMessage = '';
    try {
      const result = await cancelActionPipeAction(action.actionId, MUTATION_CANCEL_DETAIL);
      status = result.status;
      mutationOk = result.ok;
      mutationMessage = result.message;
    } catch (error) {
      mutationOk = false;
      mutationMessage = error instanceof Error ? error.message : 'Failed to cancel action.';
    } finally {
      mutatingActionRef = '';
    }
  }

  async function acknowledgeAction(action: QueuedAction): Promise<void> {
    mutatingActionRef = action.actionId;
    mutationMessage = '';
    try {
      const result = await acknowledgeActionPipeAction(action.actionId, MUTATION_ACK_DETAIL);
      status = result.status;
      mutationOk = result.ok;
      mutationMessage = result.message;
    } catch (error) {
      mutationOk = false;
      mutationMessage = error instanceof Error ? error.message : 'Failed to acknowledge action.';
    } finally {
      mutatingActionRef = '';
    }
  }

  onMount(() => {
    void loadStatus();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">Action Pipe</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Action Pipe - Backstage Queue</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Live operator surface for post-turn work, autonomous actions, retries, quarantine, and bounded subagent outcomes.
      </p>
    </div>
    <button
      onclick={refreshStatus}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  {#if mutationMessage}
    <div class="card-garden border-l-4 {mutationOk ? 'border-l-leaf-400' : 'border-l-wilt-400'} p-4">
      <p class="text-sm font-medium {mutationOk ? 'text-leaf-700' : 'text-wilt-700'}">{mutationMessage}</p>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-6 text-sm text-shadow-600">Loading action pipe status...</div>
  {:else if status}
    <ActionPipeOverview {status} />
    <ActionPipeLanes {lanes} />
    <ActionPipeQueue
      actions={queuedActions}
      {mutatingActionRef}
      onCancel={(action) => void cancelAction(action)}
      onAcknowledge={(action) => void acknowledgeAction(action)}
    />
    <ActionPipePersistence {status} />
    <ActionPipeOutreach records={outreachRecords} />
    <ActionPipeHistory panels={historyPanels} />
    <ActionPipeSubagents outcomes={subagentOutcomes} />
  {/if}
</div>
