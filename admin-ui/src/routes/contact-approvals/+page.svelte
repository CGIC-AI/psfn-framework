<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    approveContactApproval,
    denyContactApproval,
    getContactApprovals,
    resetContactApproval,
    type ContactApprovalEntry,
  } from '$lib/api/endpoints/contact-approvals';
  import { pushToast } from '$lib/stores/toast.svelte';

  // ── State ──
  let entries = $state<ContactApprovalEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);

  function formatTimestamp(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;

    try {
      const data = await getContactApprovals();
      entries = data.entries;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load contact approvals';
      }
    } finally {
      loading = false;
    }
  }

  async function handleAction(id: string, action: 'approve' | 'deny' | 'reset') {
    try {
      const result = action === 'approve'
        ? await approveContactApproval(id)
        : action === 'deny'
          ? await denyContactApproval(id)
          : await resetContactApproval(id);
      if (result.ok) {
        pushToast(
          action === 'approve'
            ? `Contact approved${result.contactId ? ` (${result.contactId})` : ''}.`
            : action === 'deny'
              ? 'Contact denied; the speaker stays untracked.'
              : 'Decision reset; the next message from the speaker re-proposes.',
          'success',
        );
      } else {
        pushToast(result.message || `Failed to ${action} contact approval.`, 'error');
      }
      await loadData();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Action failed', 'error');
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
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Contact Approvals</h1>
      <p class="text-sm text-shadow-600 mt-1">New speakers from approval-gated channels -- approve to start tracking, deny to keep untracked</p>
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

  {#if loading && entries.length === 0}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
          <div class="flex gap-2">
            <div class="h-8 rounded bg-bark-200 w-20"></div>
            <div class="h-8 rounded bg-bark-200 w-20"></div>
          </div>
        </div>
      {/each}
      <p class="text-sm text-shadow-600 px-1">Loading contact approvals...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-800">Requires the agent runtime</p>
      <p class="text-sm text-shadow-600 mt-2">
        Pending contact approvals are queued by the contact-tracking policy gate when a channel is
        configured with <code class="font-mono bg-bark-100 px-1 rounded">contactTracking: "approval"</code>
        in channels.json.
      </p>
    </div>
  {:else if entries.length === 0}
    <div class="card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">No pending contact approvals</p>
      <p class="text-sm text-shadow-600">
        New speakers from approval-gated channels will appear here. Until approved, they stay
        untracked: transcript attribution only, no contact record, no per-person memory.
      </p>
    </div>
  {:else}
    <div class="space-y-4">
      {#each entries as entry (entry.id)}
        <div class="card-garden overflow-hidden">
          <div class="px-5 py-4 border-b border-bark-100 bg-bark-50">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-semibold text-shadow-900">
                {entry.displayName}
                <span class="text-shadow-600 font-normal">({entry.channel}:{entry.channelUserId})</span>
              </h3>
              <span
                class="inline-block px-2.5 py-1 rounded-full text-sm font-medium {entry.status === 'denied' ? 'bg-wilt-100 text-wilt-600' : 'bg-gold-100 text-gold-700'}"
              >
                {entry.status === 'denied' ? 'Denied' : 'Pending'}
              </span>
            </div>
          </div>

          <div class="px-5 py-4 space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <span class="text-shadow-600">Room:</span>
                <code class="ml-1 font-mono text-shadow-800 bg-bark-100 px-1.5 py-0.5 rounded">{entry.channelId}</code>
              </div>
              <div>
                <span class="text-shadow-600">First seen:</span>
                <span class="ml-1 text-shadow-800">{formatTimestamp(entry.firstSeenAt)}</span>
              </div>
              <div>
                <span class="text-shadow-600">Last seen:</span>
                <span class="ml-1 text-shadow-800">{formatTimestamp(entry.lastSeenAt)}</span>
              </div>
              {#if entry.decidedAt}
                <div>
                  <span class="text-shadow-600">Decided:</span>
                  <span class="ml-1 text-shadow-800">{formatTimestamp(entry.decidedAt)}</span>
                </div>
              {/if}
            </div>

            {#if entry.messagePreviews.length > 0}
              <div>
                <p class="text-sm font-medium text-shadow-700 mb-1">Sample messages (this channel only)</p>
                <ul class="space-y-1">
                  {#each entry.messagePreviews as preview (preview.messageId)}
                    <li class="text-sm font-mono text-shadow-800 bg-bark-50 border border-bark-200 rounded px-2 py-1">
                      {preview.preview}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            <div class="flex flex-wrap gap-3 pt-2">
              {#if entry.status === 'pending'}
                <button
                  onclick={() => handleAction(entry.id, 'approve')}
                  class="px-4 py-2 rounded-lg text-sm font-medium
                         bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors
                         border border-moss-300"
                >
                  Approve
                </button>
                <button
                  onclick={() => handleAction(entry.id, 'deny')}
                  class="px-4 py-2 rounded-lg text-sm font-medium
                         bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors
                         border border-wilt-200"
                >
                  Deny
                </button>
              {:else}
                <button
                  onclick={() => handleAction(entry.id, 'reset')}
                  class="px-4 py-2 rounded-lg text-sm font-medium
                         bg-gold-100 text-gold-700 hover:bg-gold-200 transition-colors
                         border border-gold-300"
                >
                  Reset decision
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
