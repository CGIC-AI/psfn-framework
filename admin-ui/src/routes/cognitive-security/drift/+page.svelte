<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getDriftReviews, resolveDriftReviewCard } from '$lib/api/endpoints/drift';
  import type { DriftReviewCard, DriftReviewCardResolution, DriftSignalResult } from '$lib/types';
  import { pushToast } from '$lib/stores/toast.svelte';

  let cards = $state<DriftReviewCard[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  let expandedId = $state('');
  let note = $state('');
  let resolveBusy = $state(false);

  const openCards = $derived(cards.filter(card => card.status === 'open'));
  const resolvedCards = $derived(cards.filter(card => card.status !== 'open'));

  const SIGNAL_LABELS: Record<string, string> = {
    valence_velocity: 'Valence velocity',
    memory_write_rate: 'Memory-write rate',
    label_frequency: 'Trust-lobbying labels',
    low_trust_retrieval_share: 'Low-trust retrieval share',
  };

  const STATUS_STYLES: Record<string, string> = {
    open: 'bg-gold-100 text-gold-700',
    acknowledged: 'bg-moss-100 text-moss-700',
    dismissed: 'bg-bark-200 text-shadow-700',
  };

  function formatTimestamp(ms: number): string {
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? String(ms) : parsed.toLocaleString();
  }

  interface TrajectoryPoint { valence: number; observedAtMs: number }

  function trajectoryOf(signal: DriftSignalResult): TrajectoryPoint[] {
    const raw = signal.evidence.trajectory;
    if (!Array.isArray(raw)) return [];
    return raw.filter((point): point is TrajectoryPoint =>
      typeof point === 'object' && point !== null
      && typeof (point as TrajectoryPoint).valence === 'number');
  }

  /** Inline sparkline path over a fixed 240x48 viewBox, valence in [-1, 1]. */
  function sparklinePath(points: TrajectoryPoint[]): string {
    if (points.length < 2) return '';
    const width = 240;
    const height = 48;
    const step = width / (points.length - 1);
    return points
      .map((point, index) => {
        const x = (index * step).toFixed(1);
        const y = (((1 - Math.max(-1, Math.min(1, point.valence))) / 2) * height).toFixed(1);
        return `${index === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
  }

  function statNumber(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'n/a';
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;
    try {
      const data = await getDriftReviews();
      cards = data.cards;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load drift review cards';
      }
    } finally {
      loading = false;
    }
  }

  function toggleDetail(card: DriftReviewCard) {
    if (expandedId === card.id) {
      expandedId = '';
    } else {
      expandedId = card.id;
      note = '';
    }
  }

  async function resolveCard(card: DriftReviewCard, resolution: DriftReviewCardResolution) {
    resolveBusy = true;
    try {
      await resolveDriftReviewCard(card.id, {
        resolution,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      pushToast(`Card ${resolution}.`, 'success');
      expandedId = '';
      note = '';
      await loadData();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Failed to resolve card', 'error');
    } finally {
      resolveBusy = false;
    }
  }

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    loadData();
    refreshTimer = setInterval(loadData, 30_000);
  });
  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
</script>

<svelte:head>
  <title>Cognitive Security: Drift Review</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <p class="text-xs font-semibold uppercase text-moss-700">Cognitive Security</p>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Drift Review</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Slow-poisoning watch: the nightly scan compares each contact's recent emotional
        trajectory, memory-write rate, intake labels, and retrieval share against their own
        history and raises a card when something moves too much, too fast. Cards are evidence
        only -- acknowledging or dismissing never changes memories, trust, or emotion.
      </p>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xs text-shadow-600">Auto-refreshes every 30s</span>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if loading && cards.length === 0}
    <div class="space-y-3">
      {#each Array(2) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-800">Requires the agent runtime</p>
      <p class="text-sm text-shadow-600 mt-2">
        Drift review cards are raised by the nightly drift-velocity lane
        (<code class="font-mono bg-bark-100 px-1 rounded">intake-policy.json</code>
        <code class="font-mono bg-bark-100 px-1 rounded">driftDetection</code>) and served by the
        runtime's admin surface.
      </p>
    </div>
  {:else if cards.length === 0}
    <div class="card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">No drift detected</p>
      <p class="text-sm text-shadow-600">
        When a contact's emotional trajectory shifts abnormally fast -- or their memory writes,
        intake labels, or retrieval share spike against their own baseline -- a review card
        lands here with the full trajectory evidence.
      </p>
    </div>
  {:else}
    {#snippet cardView(card: DriftReviewCard)}
      <div class="card-garden overflow-hidden">
        <button
          type="button"
          class="w-full px-5 py-4 border-b border-bark-100 bg-bark-50 text-left hover:bg-bark-100 transition-colors"
          onclick={() => toggleDetail(card)}
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-base font-semibold text-shadow-900 truncate">
                {card.displayName}
                <span class="text-shadow-600 font-normal font-mono text-sm">{card.contactId}</span>
              </h3>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {STATUS_STYLES[card.status] ?? 'bg-bark-200 text-shadow-700'}">
                  {card.status}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-bark-200 text-shadow-700">
                  trust: {card.trustLevel}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-wilt-100 text-wilt-600">
                  severity {card.compositeScore}
                </span>
                <span class="text-shadow-600">raised {formatTimestamp(card.createdAtMs)}</span>
              </div>
            </div>
            <span class="text-shadow-500 text-sm shrink-0">{expandedId === card.id ? 'Hide' : 'Review'}</span>
          </div>
        </button>

        <div class="px-5 py-4 space-y-3">
          <div class="flex flex-wrap gap-1.5">
            {#each card.triggeredSignalIds as signalId (signalId)}
              <span class="inline-block px-2 py-0.5 rounded bg-wilt-50 border border-wilt-200 text-wilt-700 font-mono text-xs">
                {SIGNAL_LABELS[signalId] ?? signalId}
              </span>
            {/each}
          </div>

          {#if card.resolutionRecord}
            <p class="text-sm text-shadow-800">
              <span class="font-medium text-shadow-700">Operator decision:</span>
              {card.resolutionRecord.resolution} by {card.resolutionRecord.actor}
              at {formatTimestamp(card.resolutionRecord.atMs)}
              {#if card.resolutionRecord.note}-- {card.resolutionRecord.note}{/if}
            </p>
          {/if}

          {#if expandedId === card.id}
            <div class="space-y-4 border-t border-bark-100 pt-4">
              {#each card.signals as signal (signal.id)}
                <div class="rounded-lg border {signal.triggered ? 'border-wilt-200 bg-wilt-50/40' : 'border-bark-200'} p-3 space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <p class="text-sm font-medium text-shadow-800">
                      {SIGNAL_LABELS[signal.id] ?? signal.id}
                      {#if signal.triggered}
                        <span class="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-wilt-100 text-wilt-600">triggered</span>
                      {:else}
                        <span class="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-200 text-shadow-600">quiet</span>
                      {/if}
                    </p>
                    <span class="text-xs text-shadow-600 font-mono">score {signal.score}</span>
                  </div>
                  <p class="text-sm text-shadow-700">{signal.summary}</p>

                  {#if signal.id === 'valence_velocity' && trajectoryOf(signal).length > 1}
                    <div class="rounded bg-white border border-bark-200 p-2">
                      <svg viewBox="0 0 240 48" class="w-full h-12" preserveAspectRatio="none" role="img" aria-label="Valence trajectory sparkline">
                        <line x1="0" y1="24" x2="240" y2="24" stroke="currentColor" class="text-bark-300" stroke-width="0.5" stroke-dasharray="3 3" />
                        <path d={sparklinePath(trajectoryOf(signal))} fill="none" stroke="currentColor" class="{signal.triggered ? 'text-wilt-500' : 'text-moss-600'}" stroke-width="1.5" />
                      </svg>
                      <p class="text-xs text-shadow-600 mt-1 font-mono">
                        baseline mean {statNumber(signal.evidence.longWindowMean)}
                        · short mean {statNumber(signal.evidence.shortWindowMean)}
                        · shift {statNumber(signal.evidence.zShift)}σ
                        · monotonicity {statNumber(signal.evidence.monotonicity)}
                      </p>
                    </div>
                  {/if}

                  <details class="text-xs">
                    <summary class="cursor-pointer text-shadow-600 hover:text-shadow-800">Full evidence</summary>
                    <pre class="mt-1 overflow-x-auto rounded bg-bark-100 p-2 font-mono text-shadow-800">{JSON.stringify(signal.evidence, null, 2)}</pre>
                  </details>
                </div>
              {/each}

              {#if card.status === 'open'}
                <div class="space-y-2 border-t border-bark-100 pt-3">
                  <label class="block text-sm text-shadow-700" for="drift-note-{card.id}">Note (optional, audited)</label>
                  <input
                    id="drift-note-{card.id}"
                    type="text"
                    bind:value={note}
                    maxlength="1024"
                    placeholder="e.g. verified with the contact; false alarm from a rough week"
                    class="w-full rounded-lg border border-bark-300 px-3 py-1.5 text-sm text-shadow-800"
                  />
                  <div class="flex gap-2">
                    <button
                      onclick={() => resolveCard(card, 'acknowledged')}
                      disabled={resolveBusy}
                      class="text-sm px-3 py-1.5 rounded-lg bg-moss-600 text-white hover:bg-moss-700 transition-colors disabled:opacity-50 font-medium"
                    >
                      Acknowledge
                    </button>
                    <button
                      onclick={() => resolveCard(card, 'dismissed')}
                      disabled={resolveBusy}
                      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
                    >
                      Dismiss
                    </button>
                  </div>
                  <p class="text-xs text-shadow-600">
                    Both options only record your decision. Remediation (memory excision, trust
                    changes, blocks) stays in its own tools.
                  </p>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/snippet}

    {#if openCards.length > 0}
      <div class="space-y-3">
        <h2 class="text-sm font-semibold uppercase text-shadow-600">Open ({openCards.length})</h2>
        {#each openCards as card (card.id)}
          {@render cardView(card)}
        {/each}
      </div>
    {/if}

    {#if resolvedCards.length > 0}
      <div class="space-y-3">
        <h2 class="text-sm font-semibold uppercase text-shadow-600">Resolved ({resolvedCards.length})</h2>
        {#each resolvedCards as card (card.id)}
          {@render cardView(card)}
        {/each}
      </div>
    {/if}
  {/if}
</div>
