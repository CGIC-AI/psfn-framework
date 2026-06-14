<script lang="ts">
  import { onMount } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import GardenTabBar, { type GardenTabItem } from '$lib/components/garden/GardenTabBar.svelte';
  import { ApiError } from '$lib/api/client';
  import {
    buildObserverEvalSidecarExportPath,
    getObserverEvalSidecarHealth,
    getObserverEvalSidecarLatest,
    queryObserverEvalSidecarObservations,
    queryObserverEvalSidecarRuns,
    type AdminObserverEvalSidecarHealthData,
    type AdminObserverEvalSidecarObservationFilters,
    type AdminObserverEvalSidecarObservationView,
    type AdminObserverEvalSidecarRunFilters,
    type AdminObserverEvalSidecarRunView,
  } from '$lib/api/endpoints/observer-eval-sidecar';
  import {
    buildObserverEvalSidecarFilters,
    formatObserverEvalPercent,
    formatObserverEvalScore,
    formatObserverEvalSigned,
    formatObserverEvalTimestamp,
    labelizeObserverEval,
    resolveObserverEvalSidecarPageState,
    statusBadgeClass,
    topDiscreteEmotions,
    type ObserverEvalSidecarTimeRange,
  } from '$lib/evals/observer-sidecar';
  import type { EmotionStateSnapshot } from '../../../../../src/core/emotion/state.js';

  type TabId = 'overview' | 'observations' | 'runs';
  type DeploymentFilter = '' | 'live' | 'eval' | 'test_persona';

  const OBSERVATION_LIMIT_DEFAULT = '100';
  const RUN_LIMIT_DEFAULT = '50';
  const TIME_RANGE_OPTIONS: Array<{ value: ObserverEvalSidecarTimeRange; label: string }> = [
    { value: '15m', label: '15m' },
    { value: '1h', label: '1h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: 'all', label: 'All' },
  ];
  const PRIVACY_OPTIONS = ['', 'public', 'private', 'restricted', 'closed', 'fail_closed'] as const;
  const OBSERVATION_STATUS_OPTIONS = ['', 'ok', 'degraded', 'error'] as const;
  const RUN_STATUS_OPTIONS = ['', 'running', 'completed', 'degraded', 'failed'] as const;
  const LOADING_CARD_IDS = [1, 2, 3, 4] as const;
  const DEPLOYMENT_OPTIONS: Array<{ value: DeploymentFilter; label: string }> = [
    { value: '', label: 'All deployments' },
    { value: 'live', label: 'Live' },
    { value: 'eval', label: 'Eval' },
    { value: 'test_persona', label: 'Test persona' },
  ];

  let activeTab = $state<TabId>('overview');
  let health = $state<AdminObserverEvalSidecarHealthData | null>(null);
  let latest = $state<AdminObserverEvalSidecarObservationView | null>(null);
  let observations = $state<AdminObserverEvalSidecarObservationView[]>([]);
  let runs = $state<AdminObserverEvalSidecarRunView[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let unavailableMessage = $state('');
  let requestSeq = 0;

  let timeRange = $state<ObserverEvalSidecarTimeRange>('24h');
  let deploymentFilter = $state<DeploymentFilter>('');
  let runId = $state('');
  let evalSessionId = $state('');
  let scenarioId = $state('');
  let testRunId = $state('');
  let turnId = $state('');
  let privacyClass = $state('');
  let observationStatus = $state('');
  let runStatus = $state('');
  let minDivergenceScore = $state('');
  let observationLimit = $state(OBSERVATION_LIMIT_DEFAULT);
  let runLimit = $state(RUN_LIMIT_DEFAULT);

  let runDeploymentById = $derived.by(() => (
    new Map(runs.map((run) => [run.runId, run.deployment] as const))
  ));
  let filteredRuns = $derived.by(() => (
    deploymentFilter
      ? runs.filter((run) => run.deployment === deploymentFilter)
      : runs
  ));
  let filteredObservations = $derived.by(() => (
    deploymentFilter
      ? observations.filter((observation) => runDeploymentById.get(observation.runId) === deploymentFilter)
      : observations
  ));
  let latestObservation = $derived(latest ?? filteredObservations[0] ?? null);
  let pageState = $derived(resolveObserverEvalSidecarPageState({
    loading,
    errorMessage,
    unavailableMessage,
    health,
    latestObservation,
    observations: filteredObservations,
  }));
  let latestPsfnSnapshot = $derived(latestObservation?.psfnEmotion.snapshot ?? latestObservation?.emotion.snapshot ?? null);
  let latestPsfnTop = $derived.by(() => topDiscreteEmotions(latestPsfnSnapshot, 5));
  let latestProjectionDimensions = $derived.by(() => topProjectionDimensions(latestObservation));
  let currentExportPath = $derived(buildObserverEvalSidecarExportPath(buildObservationFilters(Date.now())));
  let tabs = $derived.by<GardenTabItem[]>(() => [
    { id: 'overview', label: 'Overview' },
    { id: 'observations', label: 'Observations', count: filteredObservations.length },
    { id: 'runs', label: 'Runs', count: filteredRuns.length },
  ]);

  function selectTab(tabId: string): void {
    activeTab = tabId as TabId;
  }

  function readObservationFilterInput() {
    return {
      timeRange,
      runId,
      evalSessionId,
      scenarioId,
      testRunId,
      turnId,
      privacyClass,
      status: observationStatus,
      minDivergenceScore,
      limit: observationLimit,
    };
  }

  function buildObservationFilters(nowMs: number): AdminObserverEvalSidecarObservationFilters {
    return buildObserverEvalSidecarFilters(readObservationFilterInput(), nowMs);
  }

  function buildLatestFilters(
    filters: AdminObserverEvalSidecarObservationFilters,
  ): Omit<AdminObserverEvalSidecarObservationFilters, 'limit'> {
    const { limit: _limit, ...latestFilters } = filters;
    return latestFilters;
  }

  function buildRunFilters(nowMs: number): AdminObserverEvalSidecarRunFilters {
    const observationFilters = buildObserverEvalSidecarFilters({
      timeRange,
      evalSessionId,
      scenarioId,
      testRunId,
      status: runStatus,
      limit: runLimit,
    }, nowMs);
    return {
      ...(observationFilters.evalSessionId ? { evalSessionId: observationFilters.evalSessionId } : {}),
      ...(observationFilters.scenarioId ? { scenarioId: observationFilters.scenarioId } : {}),
      ...(observationFilters.testRunId ? { testRunId: observationFilters.testRunId } : {}),
      ...(runStatus.trim() ? { status: runStatus.trim() as AdminObserverEvalSidecarRunFilters['status'] } : {}),
      ...(observationFilters.sinceMs !== undefined ? { sinceMs: observationFilters.sinceMs } : {}),
      ...(observationFilters.untilMs !== undefined ? { untilMs: observationFilters.untilMs } : {}),
      ...(observationFilters.limit !== undefined ? { limit: observationFilters.limit } : {}),
    };
  }

  async function loadData(mode: 'initial' | 'refresh' = 'initial'): Promise<void> {
    const seq = ++requestSeq;
    const nowMs = Date.now();
    const observationFilters = buildObservationFilters(nowMs);
    const latestFilters = buildLatestFilters(observationFilters);
    const runFilters = buildRunFilters(nowMs);

    if (mode === 'initial') {
      loading = true;
    } else {
      refreshing = true;
    }
    errorMessage = '';
    unavailableMessage = '';

    try {
      const healthData = await getObserverEvalSidecarHealth();
      if (seq !== requestSeq) return;
      health = healthData;
      if (!healthData.persistence.available) {
        latest = null;
        observations = [];
        runs = [];
        return;
      }

      const [latestData, observationsData, runsData] = await Promise.all([
        getObserverEvalSidecarLatest(latestFilters),
        queryObserverEvalSidecarObservations(observationFilters),
        queryObserverEvalSidecarRuns(runFilters),
      ]);
      if (seq !== requestSeq) return;
      latest = latestData.observation;
      observations = observationsData.observations;
      runs = runsData.runs;
    } catch (error) {
      if (seq !== requestSeq) return;
      if (error instanceof ApiError && error.status === 503) {
        unavailableMessage = 'Observer eval sidecar backend unavailable.';
        health = null;
        latest = null;
        observations = [];
        runs = [];
      } else {
        errorMessage = error instanceof Error ? error.message : 'Failed to load observer eval sidecar data.';
      }
    } finally {
      if (seq !== requestSeq) return;
      loading = false;
      refreshing = false;
    }
  }

  function refresh(): void {
    void loadData('refresh');
  }

  function applyFilters(): void {
    void loadData('refresh');
  }

  function resetFilters(): void {
    timeRange = '24h';
    deploymentFilter = '';
    runId = '';
    evalSessionId = '';
    scenarioId = '';
    testRunId = '';
    turnId = '';
    privacyClass = '';
    observationStatus = '';
    runStatus = '';
    minDivergenceScore = '';
    observationLimit = OBSERVATION_LIMIT_DEFAULT;
    runLimit = RUN_LIMIT_DEFAULT;
    void loadData('refresh');
  }

  function formatSnapshotValue(snapshot: EmotionStateSnapshot | null | undefined, axis: keyof EmotionStateSnapshot['vad']): string {
    return formatObserverEvalSigned(snapshot?.vad[axis]);
  }

  function formatMoodValue(snapshot: EmotionStateSnapshot | null | undefined, axis: keyof EmotionStateSnapshot['mood']): string {
    return formatObserverEvalSigned(snapshot?.mood[axis]);
  }

  function observationTitle(observation: AdminObserverEvalSidecarObservationView): string {
    const dominant = observation.emosim?.dominantEmotion;
    const psfn = observation.metrics.familyConfusion.psfnPrimaryLabel;
    if (psfn && dominant) return `${psfn} / ${dominant}`;
    if (dominant) return dominant;
    if (psfn) return psfn;
    return observation.observationId;
  }

  function runDuration(run: AdminObserverEvalSidecarRunView): string {
    const end = run.completedAtMs ?? Date.now();
    const ms = Math.max(0, end - run.startedAtMs);
    if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  function shortId(value: string): string {
    return value.length > 16 ? `${value.slice(0, 9)}...${value.slice(-4)}` : value;
  }

  function topProjectionDimensions(
    observation: AdminObserverEvalSidecarObservationView | null,
  ): Array<{ dimension: string; value: number }> {
    const dimensions = observation?.projection?.projectedAppraisal?.dimensions;
    if (!dimensions) return [];
    return Object.entries(dimensions)
      .sort(([, left], [, right]) => Math.abs(right) - Math.abs(left))
      .slice(0, 6)
      .map(([dimension, value]) => ({ dimension, value }));
  }

  function displayRunDeployment(observation: AdminObserverEvalSidecarObservationView): string {
    return runDeploymentById.get(observation.runId) ?? 'unknown';
  }

  onMount(() => {
    void loadData('initial');
  });
</script>

<div class="space-y-6">
  <GardenPageHeader
    eyebrow="Evals"
    title="Emotion Sidecar"
    description="Read-only current-system and EmoSim observer comparison."
  />

  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      onclick={refresh}
      disabled={refreshing || loading}
      class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing' : 'Refresh'}
    </button>
    <a
      href={currentExportPath}
      download="observer-eval-sidecar-export.json"
      class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-white"
    >
      Export
    </a>
    <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(pageState)}">
      {labelizeObserverEval(pageState)}
    </span>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  {#if unavailableMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{unavailableMessage}</p>
    </div>
  {/if}

  {#if loading}
    <div class="grid gap-4 md:grid-cols-4">
      {#each LOADING_CARD_IDS as cardId}
        <div class="card-garden h-32 animate-pulse bg-bark-50 p-5" aria-label={`Loading observer sidecar card ${cardId}`}></div>
      {/each}
    </div>
  {:else}
    <section class="grid gap-4 md:grid-cols-4" aria-label="Observer sidecar overview">
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Runtime</p>
        <p class="mt-3 text-2xl font-serif font-bold text-shadow-900">{labelizeObserverEval(health?.status)}</p>
        <p class="mt-2 text-sm text-shadow-600">{formatObserverEvalTimestamp(health?.observedAt)}</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Queue</p>
        <p class="mt-3 text-3xl font-serif font-bold text-shadow-900">
          {health?.runtime?.queue.queuedCount ?? 0}/{health?.runtime?.queue.maxQueuedTurns ?? 0}
        </p>
        <p class="mt-2 text-sm text-shadow-600">{health?.runtime?.queue.runningCount ?? 0} running</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Divergence</p>
        <p class="mt-3 text-3xl font-serif font-bold text-shadow-900">
          {formatObserverEvalScore(latestObservation?.metrics.score.confidenceWeightedDivergenceScore)}
        </p>
        <p class="mt-2 text-sm text-shadow-600">{labelizeObserverEval(latestObservation?.metrics.agreementBand)}</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Persistence</p>
        <p class="mt-3 text-2xl font-serif font-bold text-shadow-900">
          {health?.persistence.available ? 'Attached' : 'Unavailable'}
        </p>
        <p class="mt-2 text-sm text-shadow-600">
          {health?.persistence.evalOwned ? 'eval-owned' : 'not attached'} / non-authoritative
        </p>
      </div>
    </section>

    <GardenTabBar tabs={tabs} activeId={activeTab} onSelect={selectTab} label="Observer eval views" />

    {#if activeTab === 'overview'}
      {#if latestObservation}
        <section class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="Latest observer comparison">
          <div class="card-garden p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Current System</p>
                <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">PSFN EmotionState</h2>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(latestObservation.status)}">
                {labelizeObserverEval(latestObservation.status)}
              </span>
            </div>
            <dl class="mt-5 grid gap-3 sm:grid-cols-3">
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Valence</dt><dd class="font-mono text-lg text-shadow-900">{formatSnapshotValue(latestPsfnSnapshot, 'valence')}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Arousal</dt><dd class="font-mono text-lg text-shadow-900">{formatSnapshotValue(latestPsfnSnapshot, 'arousal')}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Dominance</dt><dd class="font-mono text-lg text-shadow-900">{formatSnapshotValue(latestPsfnSnapshot, 'dominance')}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Mood V</dt><dd class="font-mono text-lg text-shadow-900">{formatMoodValue(latestPsfnSnapshot, 'valence')}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Mood A</dt><dd class="font-mono text-lg text-shadow-900">{formatMoodValue(latestPsfnSnapshot, 'arousal')}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Confidence</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalPercent(latestPsfnSnapshot?.confidence)}</dd></div>
            </dl>
            <div class="mt-5 space-y-2">
              {#if latestPsfnTop.length === 0}
                <p class="text-sm text-shadow-600">No PSFN discrete emotion evidence recorded.</p>
              {:else}
                {#each latestPsfnTop as item (item.emotion)}
                  <div class="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
                    <span class="truncate text-shadow-700">{labelizeObserverEval(item.emotion)}</span>
                    <div class="h-2 rounded-full bg-bark-200">
                      <div class="h-2 rounded-full bg-gold-400" style={`width: ${Math.round(item.intensity * 100)}%`}></div>
                    </div>
                    <span class="font-mono text-shadow-800">{formatObserverEvalPercent(item.intensity)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>

          <div class="card-garden p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Observer Projection</p>
                <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">EmoSim</h2>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(latestObservation.metrics.agreementBand)}">
                {labelizeObserverEval(latestObservation.metrics.agreementBand)}
              </span>
            </div>
            <dl class="mt-5 grid gap-3 sm:grid-cols-3">
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Dominant</dt><dd class="text-lg font-semibold text-shadow-900">{latestObservation.emosim?.dominantEmotion ?? '-'}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Mood V</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalSigned(latestObservation.emosim?.mood?.valence)}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Mood A</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalSigned(latestObservation.emosim?.mood?.arousal)}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Projection</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalPercent(latestObservation.projection?.confidence)}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Raw Score</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalScore(latestObservation.metrics.score.rawDivergenceScore)}</dd></div>
              <div><dt class="text-xs uppercase tracking-[0.16em] text-shadow-500">Weighted</dt><dd class="font-mono text-lg text-shadow-900">{formatObserverEvalScore(latestObservation.metrics.score.confidenceWeightedDivergenceScore)}</dd></div>
            </dl>
            <div class="mt-5 space-y-2">
              {#if !latestObservation.emosim?.topEmotions?.length}
                <p class="text-sm text-shadow-600">No EmoSim emotion vector recorded.</p>
              {:else}
                {#each latestObservation.emosim.topEmotions as item (item.emotion)}
                  <div class="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
                    <span class="truncate text-shadow-700">{item.emotion}</span>
                    <div class="h-2 rounded-full bg-bark-200">
                      <div class="h-2 rounded-full bg-petal-400" style={`width: ${Math.round(item.intensity * 100)}%`}></div>
                    </div>
                    <span class="font-mono text-shadow-800">{formatObserverEvalPercent(item.intensity)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        </section>

        <section class="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" aria-label="Observer evidence">
          <div class="card-garden p-5">
            <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Projection Dimensions</p>
            <div class="mt-4 space-y-2">
              {#if latestProjectionDimensions.length === 0}
                <p class="text-sm text-shadow-600">No projected appraisal dimensions recorded.</p>
              {:else}
                {#each latestProjectionDimensions as item (item.dimension)}
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="text-shadow-700">{labelizeObserverEval(item.dimension)}</span>
                    <span class="font-mono text-shadow-900">{formatObserverEvalSigned(item.value)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div class="card-garden p-5">
            <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Provenance</p>
            <dl class="mt-4 grid gap-3 sm:grid-cols-2">
              <div><dt class="text-shadow-500 text-sm">Run</dt><dd class="font-mono text-sm text-shadow-900">{shortId(latestObservation.runId)}</dd></div>
              <div><dt class="text-shadow-500 text-sm">Turn</dt><dd class="font-mono text-sm text-shadow-900">{shortId(latestObservation.turnId)}</dd></div>
              <div><dt class="text-shadow-500 text-sm">Deployment</dt><dd class="text-sm text-shadow-900">{labelizeObserverEval(displayRunDeployment(latestObservation))}</dd></div>
              <div><dt class="text-shadow-500 text-sm">Privacy</dt><dd class="text-sm text-shadow-900">{labelizeObserverEval(latestObservation.privacy.privacyClass)}</dd></div>
              <div><dt class="text-shadow-500 text-sm">Captured</dt><dd class="text-sm text-shadow-900">{formatObserverEvalTimestamp(latestObservation.capturedAtMs)}</dd></div>
              <div><dt class="text-shadow-500 text-sm">Observed</dt><dd class="text-sm text-shadow-900">{formatObserverEvalTimestamp(latestObservation.observedAtMs)}</dd></div>
            </dl>
            {#if latestObservation.metrics.reasons.length > 0}
              <div class="mt-4 space-y-2">
                {#each latestObservation.metrics.reasons as reason (reason.code)}
                  <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-sm font-semibold text-shadow-800">{labelizeObserverEval(reason.code)}</span>
                      <span class="rounded-full border px-2 py-0.5 text-xs {statusBadgeClass(reason.severity)}">{reason.severity}</span>
                    </div>
                    <p class="mt-1 text-sm text-shadow-600">{reason.detail}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </section>
      {:else}
        <div class="card-garden p-6 text-sm text-shadow-600">No observer sidecar observations match the active filters.</div>
      {/if}
    {:else if activeTab === 'observations'}
      <section class="card-garden p-5" aria-label="Observation filters">
        <div class="grid gap-3 md:grid-cols-4 xl:grid-cols-6">
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Time</span>
            <select bind:value={timeRange} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each TIME_RANGE_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Deployment</span>
            <select bind:value={deploymentFilter} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each DEPLOYMENT_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Privacy</span>
            <select bind:value={privacyClass} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each PRIVACY_OPTIONS as option}
                <option value={option}>{option ? labelizeObserverEval(option) : 'All privacy'}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Status</span>
            <select bind:value={observationStatus} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each OBSERVATION_STATUS_OPTIONS as option}
                <option value={option}>{option ? labelizeObserverEval(option) : 'All statuses'}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Min divergence</span>
            <input bind:value={minDivergenceScore} inputmode="decimal" class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" placeholder="0.40" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Limit</span>
            <input bind:value={observationLimit} inputmode="numeric" class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Run</span>
            <input bind:value={runId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" placeholder="run id" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Turn</span>
            <input bind:value={turnId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" placeholder="turn id" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Eval session</span>
            <input bind:value={evalSessionId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Scenario</span>
            <input bind:value={scenarioId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Test run</span>
            <input bind:value={testRunId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
        </div>
        <div class="mt-4 flex gap-2">
          <button type="button" onclick={applyFilters} class="rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-sm font-medium text-gold-800">Apply</button>
          <button type="button" onclick={resetFilters} class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700">Reset</button>
        </div>
      </section>

      {#if filteredObservations.length === 0}
        <div class="card-garden p-6 text-sm text-shadow-600">No observations match the active filters.</div>
      {:else}
        <section class="space-y-3" aria-label="Observer observations">
          {#each filteredObservations as observation (observation.observationId)}
            <article class="card-garden p-4">
              <div class="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 class="font-serif text-lg font-semibold text-shadow-900">{observationTitle(observation)}</h2>
                  <p class="mt-1 text-sm text-shadow-600">
                    {formatObserverEvalTimestamp(observation.observedAtMs)} / run {shortId(observation.runId)} / {labelizeObserverEval(displayRunDeployment(observation))}
                  </p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(observation.status)}">{labelizeObserverEval(observation.status)}</span>
                  <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(observation.metrics.agreementBand)}">{labelizeObserverEval(observation.metrics.agreementBand)}</span>
                  <span class="rounded-full border border-bark-300 bg-bark-100 px-2.5 py-1 text-xs font-semibold text-shadow-700">{labelizeObserverEval(observation.privacy.privacyClass)}</span>
                </div>
              </div>
              <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                <div><dt class="text-shadow-500">Divergence</dt><dd class="font-mono text-shadow-900">{formatObserverEvalScore(observation.metrics.score.confidenceWeightedDivergenceScore)}</dd></div>
                <div><dt class="text-shadow-500">PSFN family</dt><dd class="text-shadow-900">{labelizeObserverEval(observation.metrics.familyConfusion.psfnPrimaryFamily)}</dd></div>
                <div><dt class="text-shadow-500">EmoSim family</dt><dd class="text-shadow-900">{labelizeObserverEval(observation.metrics.familyConfusion.emosimPrimaryFamily)}</dd></div>
                <div><dt class="text-shadow-500">Projection</dt><dd class="font-mono text-shadow-900">{formatObserverEvalPercent(observation.projection?.confidence)}</dd></div>
                <div><dt class="text-shadow-500">VAD distance</dt><dd class="font-mono text-shadow-900">{formatObserverEvalScore(observation.metrics.deltas.vadDistance)}</dd></div>
              </dl>
              {#if observation.metrics.reasons.length > 0}
                <div class="mt-3 flex flex-wrap gap-2">
                  {#each observation.metrics.reasons.slice(0, 4) as reason (reason.code)}
                    <span class="rounded-full border border-bark-300 bg-bark-50 px-2.5 py-1 text-xs text-shadow-700">
                      {labelizeObserverEval(reason.code)}
                    </span>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </section>
      {/if}
    {:else if activeTab === 'runs'}
      <section class="card-garden p-5" aria-label="Run filters">
        <div class="grid gap-3 md:grid-cols-4 xl:grid-cols-6">
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Time</span>
            <select bind:value={timeRange} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each TIME_RANGE_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Deployment</span>
            <select bind:value={deploymentFilter} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each DEPLOYMENT_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Status</span>
            <select bind:value={runStatus} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
              {#each RUN_STATUS_OPTIONS as option}
                <option value={option}>{option ? labelizeObserverEval(option) : 'All statuses'}</option>
              {/each}
            </select>
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Limit</span>
            <input bind:value={runLimit} inputmode="numeric" class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Eval session</span>
            <input bind:value={evalSessionId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
          <label class="space-y-1 text-sm text-shadow-700">
            <span class="font-medium">Scenario</span>
            <input bind:value={scenarioId} class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2" />
          </label>
        </div>
        <div class="mt-4 flex gap-2">
          <button type="button" onclick={applyFilters} class="rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-sm font-medium text-gold-800">Apply</button>
          <button type="button" onclick={resetFilters} class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700">Reset</button>
        </div>
      </section>

      {#if filteredRuns.length === 0}
        <div class="card-garden p-6 text-sm text-shadow-600">No observer sidecar runs match the active filters.</div>
      {:else}
        <section class="grid gap-4 lg:grid-cols-2" aria-label="Observer sidecar runs">
          {#each filteredRuns as run (run.runId)}
            <article class="card-garden p-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h2 class="font-serif text-lg font-semibold text-shadow-900">{shortId(run.runId)}</h2>
                  <p class="mt-1 text-sm text-shadow-600">{labelizeObserverEval(run.deployment)} / {run.sidecarId}</p>
                </div>
                <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {statusBadgeClass(run.status)}">{labelizeObserverEval(run.status)}</span>
              </div>
              <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div><dt class="text-shadow-500">Started</dt><dd class="text-shadow-900">{formatObserverEvalTimestamp(run.startedAtMs)}</dd></div>
                <div><dt class="text-shadow-500">Duration</dt><dd class="text-shadow-900">{runDuration(run)}</dd></div>
                <div><dt class="text-shadow-500">Eval session</dt><dd class="font-mono text-shadow-900">{run.evalSessionId ? shortId(run.evalSessionId) : '-'}</dd></div>
                <div><dt class="text-shadow-500">Scenario</dt><dd class="font-mono text-shadow-900">{run.scenarioId ? shortId(run.scenarioId) : '-'}</dd></div>
                <div><dt class="text-shadow-500">Test run</dt><dd class="font-mono text-shadow-900">{run.testRunId ? shortId(run.testRunId) : '-'}</dd></div>
                <div><dt class="text-shadow-500">Retention</dt><dd class="text-shadow-900">{labelizeObserverEval(run.retention.retentionClass)}</dd></div>
              </dl>
            </article>
          {/each}
        </section>
      {/if}
    {/if}
  {/if}
</div>
