<script lang="ts">
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { onMount, onDestroy } from 'svelte';
  import {
    loadConfirmationsLocalFirst,
    resolveConfirmation,
  } from '$lib/api/endpoints/confirmations';
  import type {
    ConfirmationQueueEntryView,
    ConfirmationDecision,
    ProvenanceSourceKind,
    PublicationProvenanceView,
  } from '$lib/types';
  import { pushToast } from '$lib/stores/toast.svelte';
  import { createGardenQueueRefresh } from '$lib/polling/garden-queue-refresh';
  import {
    createSilentBackgroundRevalidation,
    reconcilePollingSnapshot,
  } from '$lib/polling/silent-background-revalidation';

  // ── State ──
  let entries = $state<ConfirmationQueueEntryView[]>([]);
  let available = $state(true);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  let actionMessage = $state('');
  let actionIsError = $state(false);
  let backgroundError = $state('');
  let initialized = false;

  // Track modified params per entry
  let modifiedParams = $state<Record<string, string>>({});

  function formatTimestamp(value: number): string {
    return new Date(value).toLocaleString();
  }

  // Friendly, kind-specific titles for known confirmation methods. Falls back
  // to the raw method identifier for any proposal kind without a label.
  const METHOD_LABELS: Record<string, string> = {
    'identity.card.update': 'Persona / character card update',
    'contact.trust.promote': 'Trusted-tier promotion',
  };

  function methodLabel(method: string): string {
    return METHOD_LABELS[method] ?? method;
  }

  function stringifyParams(params: Record<string, unknown>): string {
    try {
      return JSON.stringify(params, null, 2);
    } catch {
      return '{}';
    }
  }

  // ── Disclosure provenance (jp36.7.2) ──
  // Content-free labels for the admitted-source kinds a publication candidate
  // draws from. The provenance view carries refs/ids/counts only — never the
  // candidate body — so nothing here renders transcript text.
  const PROVENANCE_KIND_LABELS: Record<ProvenanceSourceKind, string> = {
    memory: 'Derived memory',
    conversation: 'Conversation',
    project: 'Project / wiki',
    tool: 'Tool result',
    other: 'Other source',
  };

  function provenanceKindLabel(kind: ProvenanceSourceKind): string {
    return PROVENANCE_KIND_LABELS[kind] ?? kind;
  }

  // Explicit "unknown" wherever provenance could not be resolved — fail closed,
  // never blank and never fabricated.
  function sensitivityText(value: PublicationProvenanceView['effectiveSensitivity']): string {
    return value === 'unknown' ? 'Unknown' : value;
  }

  async function loadData() {
    backgroundRefresh.invalidate();
    loading = true;
    error = '';
    endpointMissing = false;
    backgroundError = '';
    let rendered = false;

    try {
      await loadConfirmationsLocalFirst((data, source) => {
        rendered = true;
        const reconciled = reconcilePollingSnapshot(entries, data.entries);
        if (reconciled !== entries) entries = reconciled;
        available = data.available;
        if (data.message) {
          actionMessage = data.message;
        }
        for (const entry of data.entries) {
          if (!modifiedParams[entry.id]) {
            modifiedParams[entry.id] = stringifyParams(entry.params);
          }
        }
        if (source === 'cache') loading = false;
      });
    } catch (e) {
      if (rendered) {
        backgroundError = e instanceof Error ? e.message : 'Failed to refresh confirmations';
      } else if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load confirmations';
      }
    } finally {
      loading = false;
      initialized = true;
    }
  }

  const backgroundRefresh = createSilentBackgroundRevalidation({
    load: publish => loadConfirmationsLocalFirst(data => {
      publish({ entries: data.entries, available: data.available });
    }),
    read: () => ({ entries, available }),
    write: (data) => {
      if (data.entries !== entries) entries = data.entries;
      available = data.available;
    },
    reportError: message => { backgroundError = message; },
    fallbackError: 'Failed to refresh confirmations',
  });

  async function handleResolve(id: string, decision: ConfirmationDecision) {
    actionMessage = '';
    actionIsError = false;

    let resolveModifiedParams: Record<string, unknown> | undefined;
    if (decision === 'modify') {
      const raw = modifiedParams[id]?.trim();
      if (!raw) {
        actionMessage = 'Modified params JSON is required for modify.';
        actionIsError = true;
        pushToast(actionMessage, 'error');
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          actionMessage = 'Modified params must be a JSON object.';
          actionIsError = true;
          pushToast(actionMessage, 'error');
          return;
        }
        resolveModifiedParams = parsed as Record<string, unknown>;
      } catch {
        actionMessage = 'Invalid JSON in modified params.';
        actionIsError = true;
        pushToast(actionMessage, 'error');
        return;
      }
    }

    try {
      const result = await resolveConfirmation(id, decision, resolveModifiedParams);
      if (result.ok) {
        actionMessage = result.message || `Confirmation ${decision}d successfully.`;
        actionIsError = false;
        pushToast(actionMessage, 'success');
      } else {
        actionMessage = result.message || `Failed to ${decision} confirmation.`;
        actionIsError = true;
        pushToast(actionMessage, 'error');
      }
      // Reload after action
      await loadData();
    } catch (e) {
      actionMessage = e instanceof Error ? e.message : 'Action failed';
      actionIsError = true;
      pushToast(actionMessage, 'error');
    }
  }

  const queueRefresh = createGardenQueueRefresh({
    queue: 'confirmations',
    refresh: () => initialized ? backgroundRefresh.refresh() : loadData(),
    intervalMs: 15_000,
  });

  onMount(() => {
    queueRefresh.start();
  });

  onDestroy(() => {
    queueRefresh.stop();
    backgroundRefresh.dispose();
  });
</script>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Review & Safety · Action queue"
    title="The Gate"
    description="Review the exact scope, provenance, and parameters of actions awaiting an operator decision."
  >
    {#snippet actions()}
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
    {/snippet}
  </GardenPageHeader>

  {#if backgroundError}
    <p class="garden-error rounded border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700" role="status">
      Background refresh failed: {backgroundError}. Showing the last available queue.
    </p>
  {/if}

  <section class="garden-metric-grid grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-bark-300 bg-bark-300 shadow-sm sm:grid-cols-3" aria-label="Confirmation queue summary">
    <div class="garden-metric bg-surface px-4 py-3">
      <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Pending decisions</p>
      <p class="mt-1 font-serif text-2xl font-semibold text-shadow-900">{entries.length}</p>
    </div>
    <div class="garden-metric bg-surface px-4 py-3">
      <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Gateway posture</p>
      <p class="mt-1 text-sm font-semibold {available ? 'text-moss-700' : 'text-wilt-600'}">{available ? 'Connected · decisions enabled' : 'Unavailable · fail closed'}</p>
    </div>
    <div class="garden-metric bg-surface px-4 py-3">
      <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Queue cadence</p>
      <p class="mt-1 font-serif text-2xl font-semibold text-shadow-900">15s</p>
    </div>
  </section>

  <!-- Action message -->
  {#if actionMessage}
    <div class="card-garden p-4 border-l-4 {actionIsError ? 'border-l-wilt-400' : 'border-l-moss-400'} flex items-start gap-3">
      <p class="text-sm {actionIsError ? 'text-wilt-600' : 'text-moss-700'} flex-1">{actionMessage}</p>
      <button
        data-esc-close
        onclick={() => actionMessage = ''}
        class="text-shadow-500 hover:text-shadow-700 leading-none text-lg"
        aria-label="Dismiss action message"
      >
        &times;
      </button>
    </div>
  {/if}

  {#if loading && entries.length === 0}
    <div class="garden-loading space-y-3">
      {#each Array(3) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
          <div class="h-20 rounded bg-bark-200"></div>
          <div class="flex gap-2">
            <div class="h-8 rounded bg-bark-200 w-20"></div>
            <div class="h-8 rounded bg-bark-200 w-20"></div>
            <div class="h-8 rounded bg-bark-200 w-20"></div>
          </div>
        </div>
      {/each}
      <p class="text-sm text-shadow-600 px-1">Loading confirmation queue...</p>
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
    <div class="garden-empty card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">Gateway not connected</p>
      <p class="text-sm text-shadow-600">Confirmations require an active gateway connection. The approval queue will appear here when the agent is running with the gateway.</p>
    </div>
  {:else if entries.length === 0}
    <div class="garden-empty card-garden p-12 text-center">
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
    <div class="garden-split-view grid gap-4 xl:grid-cols-2">
      {#each entries as entry (entry.id)}
        <article class="garden-section card-garden overflow-hidden">
          <!-- Entry header -->
          <div class="px-5 py-4 border-b border-bark-100 bg-bark-50">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-base font-semibold text-shadow-900">
                  {methodLabel(entry.method)}
                  <span class="text-shadow-600 font-normal">({entry.action})</span>
                </h3>
                <p class="text-xs text-shadow-500 font-mono mt-0.5">{entry.method}</p>
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

            <!-- Disclosure provenance (publication candidates only) -->
            {#if entry.disclosureProvenance}
              {@const prov = entry.disclosureProvenance}
              <section
                class="rounded-lg border border-bark-200 bg-bark-50/70 p-4 space-y-3"
                aria-label="Disclosure provenance"
                data-testid="disclosure-provenance"
              >
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-sm font-semibold text-shadow-900">Disclosure provenance</h4>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-moss-100 text-moss-700">
                    Publication candidate
                  </span>
                </div>
                <p class="text-xs text-shadow-600">
                  Where this candidate's content came from — derived memories, conversations, and sources.
                  References and indicators only; no source content is shown here.
                </p>

                {#if prov.malformed}
                  <p class="text-sm text-wilt-600 border-l-4 border-l-wilt-400 pl-3">
                    Provenance metadata is unavailable or malformed for this publication candidate.
                    Approve only with independent knowledge of what it draws from.
                  </p>
                {:else}
                  <!-- Candidate-level indicators -->
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                    <div>
                      <span class="text-shadow-600">Effective sensitivity:</span>
                      <span
                        class="ml-1 font-medium {prov.status.effectiveSensitivity === 'unknown' ? 'text-wilt-600' : 'text-shadow-800'}"
                      >{sensitivityText(prov.effectiveSensitivity)}</span>
                    </div>
                    <div>
                      <span class="text-shadow-600">Admitted sources:</span>
                      <span class="ml-1 text-shadow-800">
                        {prov.status.sources === 'unknown' ? 'Unknown' : prov.sourceCount}
                      </span>
                    </div>
                    {#if prov.candidateId}
                      <div class="md:col-span-2">
                        <span class="text-shadow-600">Candidate:</span>
                        <code class="ml-1 font-mono text-xs text-shadow-800 bg-bark-100 px-1.5 py-0.5 rounded">{prov.candidateId}</code>
                      </div>
                    {/if}
                    {#if prov.contentHash}
                      <div class="md:col-span-2">
                        <span class="text-shadow-600">Content hash:</span>
                        <code class="ml-1 font-mono text-xs text-shadow-500 bg-bark-100 px-1.5 py-0.5 rounded break-all">{prov.contentHash}</code>
                      </div>
                    {/if}
                  </div>

                  {#if prov.hasUnclassifiedSource === true}
                    <p class="text-xs text-wilt-600 border-l-4 border-l-wilt-400 pl-3">
                      At least one admitted source lacks usable disclosure lineage (unclassified).
                    </p>
                  {/if}

                  <!-- Source-kind rollup -->
                  {#if prov.sourceKindCounts.length > 0}
                    <div class="flex flex-wrap gap-1.5">
                      {#each prov.sourceKindCounts as kindCount (kindCount.kind)}
                        <span class="inline-block px-2 py-0.5 rounded-full text-xs bg-bark-100 text-shadow-700">
                          {provenanceKindLabel(kindCount.kind)}: {kindCount.count}
                        </span>
                      {/each}
                    </div>
                  {/if}

                  <!-- Admitted-source list with sensitivity/subject indicators -->
                  <div>
                    <p class="text-xs font-medium text-shadow-700 mb-1">Admitted sources</p>
                    {#if prov.status.sources === 'unknown'}
                      <p class="text-sm text-wilt-600">Unknown — source list not provided.</p>
                    {:else if prov.sources.length === 0}
                      <p class="text-sm text-shadow-600">No admitted sources recorded.</p>
                    {:else}
                      <ul class="space-y-1">
                        {#each prov.sources as source (source.ref)}
                          <li class="text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span class="px-1.5 py-0.5 rounded bg-bark-100 text-shadow-600">{provenanceKindLabel(source.kind)}</span>
                            <code class="font-mono text-shadow-800 break-all">{source.ref}</code>
                            <span class="text-shadow-500">·</span>
                            <span class="{source.sensitivity === 'unknown' ? 'text-wilt-600' : 'text-shadow-700'}">
                              {source.sensitivity === 'unknown' ? 'sensitivity unknown' : source.sensitivity}
                            </span>
                            {#if source.subjectContactIds.length > 0}
                              <span class="text-shadow-500">·</span>
                              <span class="text-shadow-700">subjects: {source.subjectContactIds.join(', ')}</span>
                            {/if}
                            {#if source.classified === false}
                              <span class="px-1.5 py-0.5 rounded bg-wilt-100 text-wilt-600">unclassified</span>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>

                  <!-- Subject contacts (candidate-level) -->
                  <div>
                    <p class="text-xs font-medium text-shadow-700 mb-1">Subjects involved</p>
                    {#if prov.status.subjectContactIds === 'unknown'}
                      <p class="text-sm text-wilt-600">Unknown — subject list not provided.</p>
                    {:else if prov.subjectContactIds.length === 0}
                      <p class="text-sm text-shadow-600">None recorded.</p>
                    {:else}
                      <div class="flex flex-wrap gap-1.5">
                        {#each prov.subjectContactIds as contactId (contactId)}
                          <code class="font-mono text-xs px-1.5 py-0.5 rounded bg-bark-100 text-shadow-800">{contactId}</code>
                        {/each}
                      </div>
                    {/if}
                  </div>

                  <!-- Destinations -->
                  <div>
                    <p class="text-xs font-medium text-shadow-700 mb-1">Proposed destinations</p>
                    {#if prov.status.destinations === 'unknown'}
                      <p class="text-sm text-wilt-600">Unknown — destinations not provided.</p>
                    {:else if prov.destinations.length === 0}
                      <p class="text-sm text-shadow-600">None recorded.</p>
                    {:else}
                      <ul class="space-y-1">
                        {#each prov.destinations as destination, index (index)}
                          <li class="text-xs flex flex-wrap items-center gap-x-2">
                            <span class="px-1.5 py-0.5 rounded bg-bark-100 text-shadow-700">{destination.kind}</span>
                            {#each destination.channelIds as channelId (channelId)}
                              <code class="font-mono text-shadow-800 break-all">{channelId}</code>
                            {/each}
                            {#each destination.contactIds as contactId (contactId)}
                              <code class="font-mono text-shadow-800 break-all">{contactId}</code>
                            {/each}
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/if}
              </section>
            {/if}

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
            <div class="flex flex-wrap gap-3 pt-2">
              <button
                onclick={() => handleResolve(entry.id, 'approve')}
                class="garden-action garden-action--primary px-4 py-2 rounded-lg text-sm font-medium
                       bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors
                       border border-moss-300"
              >
                Approve
              </button>
              <button
                onclick={() => handleResolve(entry.id, 'deny')}
                class="garden-action garden-action--danger px-4 py-2 rounded-lg text-sm font-medium
                       bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors
                       border border-wilt-200"
              >
                Deny
              </button>
              <button
                onclick={() => handleResolve(entry.id, 'modify')}
                class="garden-action px-4 py-2 rounded-lg text-sm font-medium
                       bg-gold-100 text-gold-700 hover:bg-gold-200 transition-colors
                       border border-gold-300"
              >
                Modify
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
