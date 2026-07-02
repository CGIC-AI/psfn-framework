<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    approveGraphProposal,
    getGraphProposals,
    rejectGraphProposal,
    SOCIAL_RELATIONSHIP_KINDS,
    type GraphProposal,
  } from '$lib/api/endpoints/graph-proposals';
  import { pushToast } from '$lib/stores/toast.svelte';

  let proposals = $state<GraphProposal[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  let adjustType = $state<Record<string, string>>({});

  function formatTimestamp(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;
    try {
      const data = await getGraphProposals();
      proposals = data.proposals;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load graph proposals';
      }
    } finally {
      loading = false;
    }
  }

  async function handleApprove(p: GraphProposal) {
    try {
      const chosen = adjustType[p.id] && adjustType[p.id] !== p.relationshipType ? adjustType[p.id] : undefined;
      const result = await approveGraphProposal(p.id, chosen);
      if (result.ok) {
        pushToast(`Edge written (${result.relationshipType ?? p.relationshipType}).`, 'success');
      } else {
        pushToast(result.message || 'Failed to approve proposal.', 'error');
      }
      await loadData();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Action failed', 'error');
    }
  }

  async function handleReject(p: GraphProposal) {
    try {
      const result = await rejectGraphProposal(p.id);
      if (result.ok) {
        pushToast('Proposal rejected; the same evidence will not re-propose.', 'success');
      } else {
        pushToast(result.message || 'Failed to reject proposal.', 'error');
      }
      await loadData();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Action failed', 'error');
    }
  }

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
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Graph Proposals</h1>
      <p class="text-sm text-shadow-600 mt-1">Social-graph edges proposed from accumulated room evidence -- approve to write the edge, reject to keep it out</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xs text-shadow-600">Auto-refreshes every 15s</span>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if loading && proposals.length === 0}
    <p class="text-sm text-shadow-600 px-1">Loading graph proposals...</p>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-800">Requires the agent runtime</p>
      <p class="text-sm text-shadow-600 mt-2">
        Proposals are emitted by the background graph-builder worker (memory-agent lane). They are not live edges until approved here.
      </p>
    </div>
  {:else if proposals.length === 0}
    <div class="card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">No graph proposals</p>
      <p class="text-sm text-shadow-600">The graph-builder worker will surface proposed edges here as room evidence accumulates.</p>
    </div>
  {:else}
    <div class="space-y-4">
      {#each proposals as p (p.id)}
        <div class="card-garden overflow-hidden">
          <div class="px-5 py-4 border-b border-bark-100 bg-bark-50 flex items-center justify-between">
            <h3 class="text-base font-semibold text-shadow-900">
              {p.sourceDisplayName} &harr; {p.targetDisplayName}
              <span class="text-shadow-600 font-normal">({p.relationshipType}{p.directional ? ', directed' : ''})</span>
            </h3>
            <span class="inline-block px-2.5 py-1 rounded-full text-sm font-medium {p.status === 'conflict' ? 'bg-wilt-100 text-wilt-600' : p.status === 'accepted' ? 'bg-moss-100 text-moss-700' : p.status === 'rejected' ? 'bg-bark-200 text-shadow-600' : 'bg-gold-100 text-gold-700'}">
              {p.status}
            </span>
          </div>
          <div class="px-5 py-4 space-y-3 text-sm">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div><span class="text-shadow-600">Evidence:</span> <span class="text-shadow-800">{p.evidenceClass}</span></div>
              <div><span class="text-shadow-600">Confidence:</span> <span class="text-shadow-800">{p.confidence.toFixed(2)}</span></div>
              <div><span class="text-shadow-600">Sensitivity:</span> <span class="text-shadow-800">{p.sensitivity}</span></div>
              <div><span class="text-shadow-600">Evidence memories:</span> <span class="text-shadow-800">{p.evidenceMemoryIds.length}</span></div>
              {#if p.channelId}<div><span class="text-shadow-600">Room:</span> <code class="font-mono bg-bark-100 px-1 rounded">{p.channelId}</code></div>{/if}
              <div><span class="text-shadow-600">Created:</span> <span class="text-shadow-800">{formatTimestamp(p.createdAt)}</span></div>
            </div>
            <p class="text-shadow-700">{p.rationale}</p>
            {#if p.status === 'conflict'}
              <p class="text-wilt-600">Conflicts with existing edge {p.conflictEdgeId} (type: {p.conflictEdgeType}). Approving overwrites nothing until you accept a type below.</p>
            {/if}

            {#if p.status === 'pending' || p.status === 'conflict'}
              <div class="flex flex-wrap items-center gap-3 pt-2">
                <label class="text-shadow-600">Type:
                  <select bind:value={adjustType[p.id]} class="ml-1 rounded border border-bark-300 px-2 py-1 text-shadow-800">
                    <option value={p.relationshipType}>{p.relationshipType} (proposed)</option>
                    {#each SOCIAL_RELATIONSHIP_KINDS.filter(k => k !== p.relationshipType) as k}
                      <option value={k}>{k}</option>
                    {/each}
                  </select>
                </label>
                <button onclick={() => handleApprove(p)} class="px-4 py-2 rounded-lg text-sm font-medium bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors border border-moss-300">Approve</button>
                <button onclick={() => handleReject(p)} class="px-4 py-2 rounded-lg text-sm font-medium bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors border border-wilt-200">Reject</button>
              </div>
            {:else}
              <p class="text-shadow-600">Decided{p.decidedAt ? ` ${formatTimestamp(p.decidedAt)}` : ''}{p.decidedBy ? ` by ${p.decidedBy}` : ''}{p.acceptedRelationshipType ? ` as ${p.acceptedRelationshipType}` : ''}.</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
