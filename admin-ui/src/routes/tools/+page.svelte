<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import FailureRow from '$lib/components/tools/FailureRow.svelte';
  import ServiceHealthPanel from '$lib/components/tools/ServiceHealthPanel.svelte';
  import ToolCard from '$lib/components/tools/ToolCard.svelte';
  import {
    ALL_TOOL_FILTERS,
    countInventoryTools,
    defaultToolInventoryFilters,
    deriveToolInventoryFilterOptions,
    filterInventoryGroups,
    hasActiveToolInventoryFilters,
    type ToolInventoryFilterOption,
  } from '$lib/components/tools/filter-tools';
  import {
    AVAILABILITY_LABELS,
    formatTimestamp,
    HEALTH_LABELS,
    telemetryEventDetail,
    telemetryEventMeta,
    telemetryEventTitle,
  } from '$lib/components/tools/tool-display';
  import { getAdaptiveTools } from '$lib/api/endpoints/tools';
  import type {
    AdminAdaptiveToolsData,
    AdminToolHealthView,
    AdminToolInventoryGroup,
  } from '$lib/types/tools';

  const MEMORY_WORKFLOW_TOOL_NAMES = [
    'memory_write',
    'start_focus',
    'complete_focus',
    'session_search',
    'session_grep',
    'contact_lookup',
    'contact_list',
    'contact_set_trust',
    'contact_note',
    'contact_set_channel_privacy',
    'contact_link_identity',
  ] as const;

  const MEMORY_ADMIN_LINKS = [
    {
      title: 'Memory Browser',
      detail: 'Inspect scoped memories, repair scope tags, and manage links.',
      href: `${base}/memory`,
    },
    {
      title: 'Contacts',
      detail: 'Review profiles, relationship state, and social graph data.',
      href: `${base}/contacts`,
    },
    {
      title: 'Models',
      detail: 'Assign memory-purpose models and provider routing.',
      href: `${base}/models`,
    },
    {
      title: 'Providers',
      detail: 'Edit LiteLLM, OpenRouter, and direct backend provider wiring.',
      href: `${base}/settings#settings-providers`,
    },
  ] as const;

  let data = $state<AdminAdaptiveToolsData | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let inventoryFilters = $state(defaultToolInventoryFilters());

  let toolHealthByName = $derived.by(() => (
    new Map((data?.toolHealth ?? []).map((tool) => [tool.name, tool] as const))
  ));

  let memoryWorkflowTools = $derived.by(() => (
    MEMORY_WORKFLOW_TOOL_NAMES
      .map((name) => toolHealthByName.get(name))
      .filter((tool): tool is AdminToolHealthView => Boolean(tool))
  ));

  let missingMemoryWorkflowTools = $derived.by(() => (
    MEMORY_WORKFLOW_TOOL_NAMES.filter((name) => !toolHealthByName.has(name))
  ));

  let inventoryGroups = $derived.by(() => (data?.inventory ?? ([] as AdminToolInventoryGroup[])));

  let inventoryFilterOptions = $derived.by(() => (
    deriveToolInventoryFilterOptions(inventoryGroups)
  ));

  let filteredInventoryGroups = $derived.by(() => (
    filterInventoryGroups(inventoryGroups, inventoryFilters)
  ));

  let inventoryTotalCount = $derived.by(() => countInventoryTools(inventoryGroups));
  let inventoryFilteredCount = $derived.by(() => countInventoryTools(filteredInventoryGroups));
  let hasInventoryFilters = $derived(hasActiveToolInventoryFilters(inventoryFilters));

  let recentTelemetry = $derived.by(() => (
    (data?.recentTelemetry ?? []).slice().reverse()
  ));

  let summary = $derived.by(() => ({
    registeredTools: data?.catalog?.tools.length ?? 0,
    activeTools: data?.state?.activeTools.length ?? 0,
    promotedActive: data?.state?.promotedToolsActive.length ?? 0,
    recentFailures: data?.recentFailures.length ?? 0,
  }));

  async function loadData() {
    errorMessage = '';
    try {
      data = await getAdaptiveTools();
    } catch (error) {
      errorMessage = error instanceof Error
        ? error.message
        : 'Failed to load adaptive tools data.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshData() {
    refreshing = true;
    await loadData();
  }

  function clearInventoryFilters() {
    const next = defaultToolInventoryFilters();
    inventoryFilters.query = next.query;
    inventoryFilters.groupKey = next.groupKey;
    inventoryFilters.scope = next.scope;
    inventoryFilters.healthStatus = next.healthStatus;
    inventoryFilters.chatStatus = next.chatStatus;
    inventoryFilters.heartbeatStatus = next.heartbeatStatus;
  }

  function optionWithCount(label: string, option: ToolInventoryFilterOption): string {
    return `${label} (${option.count})`;
  }

  function scopeLabel(scope: string): string {
    if (scope === 'core') return 'Core';
    if (scope === 'extended') return 'Extended';
    if (scope === 'conditional') return 'Conditional';
    return scope;
  }

  function healthStatusLabel(status: string): string {
    return HEALTH_LABELS[status as keyof typeof HEALTH_LABELS] ?? status;
  }

  function availabilityStatusLabel(status: string): string {
    return AVAILABILITY_LABELS[status as keyof typeof AVAILABILITY_LABELS] ?? status;
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">The Shed</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Tools</h1>
      <p class="mt-1 text-sm text-shadow-600">
        Direct runtime tool availability for registered tools, service health, adaptive activation, and audit signals.
      </p>
    </div>
    <button
      onclick={refreshData}
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

  <section class="space-y-4" aria-labelledby="tools-overview-heading">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Overview</p>
      <h2 id="tools-overview-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
        Runtime command board
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        Counts from the live agent catalog and the current adaptive runtime snapshot.
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-4">
      <div class="card-garden overflow-hidden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Registered</p>
        <p class="mt-3 text-4xl font-serif font-bold text-shadow-900">{summary.registeredTools}</p>
        <p class="mt-2 text-sm text-shadow-600">Direct tools currently in the runtime catalog.</p>
      </div>
      <div class="card-garden overflow-hidden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Active Now</p>
        <p class="mt-3 text-4xl font-serif font-bold text-petal-500">{summary.activeTools}</p>
        <p class="mt-2 text-sm text-shadow-600">Tools active in the current adaptive runtime snapshot.</p>
      </div>
      <div class="card-garden overflow-hidden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Promoted Active</p>
        <p class="mt-3 text-4xl font-serif font-bold text-gold-600">{summary.promotedActive}</p>
        <p class="mt-2 text-sm text-shadow-600">Promoted extended tools currently in the active set.</p>
      </div>
      <div class="card-garden overflow-hidden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Recent Failures</p>
        <p class="mt-3 text-4xl font-serif font-bold text-wilt-500">{summary.recentFailures}</p>
        <p class="mt-2 text-sm text-shadow-600">Latest soft and hard tool failures observed by admin telemetry.</p>
      </div>
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="tools-health-heading">
    <div class="flex items-baseline gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Health</p>
        <h2 id="tools-health-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Runtime dependencies
        </h2>
      </div>
      <span class="text-sm text-shadow-600">{data?.serviceHealth.length ?? 0} services</span>
    </div>

    {#if loading}
      <div class="grid gap-4 md:grid-cols-3">
        {#each Array(3) as _}
          <div class="card-garden animate-pulse p-5">
            <div class="h-4 w-24 rounded bg-bark-200"></div>
            <div class="mt-3 h-8 w-20 rounded bg-bark-100"></div>
            <div class="mt-4 h-3 w-full rounded bg-bark-100"></div>
            <div class="mt-2 h-3 w-3/4 rounded bg-bark-100"></div>
          </div>
        {/each}
      </div>
    {:else if data?.serviceHealth.length}
      <div class="grid gap-4 md:grid-cols-3">
        {#each data.serviceHealth as service}
          <ServiceHealthPanel {service} />
        {/each}
      </div>
    {:else}
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-500">No runtime service health data is available.</p>
      </div>
    {/if}
  </section>

  <section class="space-y-5" aria-labelledby="tools-inventory-heading">
    <div class="flex items-baseline gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Inventory</p>
        <h2 id="tools-inventory-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Tool catalog by runtime role
        </h2>
      </div>
      <span class="text-sm text-shadow-600">
        {inventoryFilteredCount} / {inventoryTotalCount} runtime-derived rows
      </span>
    </div>

    {#if !loading && inventoryGroups.length}
      <div class="card-garden p-5 space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-serif font-semibold text-shadow-900">Inventory Filters</h3>
            <p class="mt-1 text-sm text-shadow-600">
              Showing {inventoryFilteredCount} of {inventoryTotalCount} tools
              {#if filteredInventoryGroups.length}
                across {filteredInventoryGroups.length} groups.
              {:else}
                across 0 groups.
              {/if}
            </p>
          </div>
          <button
            type="button"
            onclick={clearInventoryFilters}
            disabled={!hasInventoryFilters}
            class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear filters
          </button>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label class="block md:col-span-2 xl:col-span-1">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Search</span>
            <input
              data-search-shortcut
              type="search"
              bind:value={inventoryFilters.query}
              placeholder="Search name or description"
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors placeholder:text-shadow-400 focus:border-gold-400"
            />
          </label>

          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Inventory Group</span>
            <select
              bind:value={inventoryFilters.groupKey}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors focus:border-gold-400"
            >
              <option value={ALL_TOOL_FILTERS}>All groups ({inventoryTotalCount})</option>
              {#each inventoryFilterOptions.groups as option}
                <option value={option.value}>
                  {optionWithCount(option.label ?? option.value, option)}
                </option>
              {/each}
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Scope</span>
            <select
              bind:value={inventoryFilters.scope}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors focus:border-gold-400"
            >
              <option value={ALL_TOOL_FILTERS}>All scopes ({inventoryTotalCount})</option>
              {#each inventoryFilterOptions.scopes as option}
                <option value={option.value}>
                  {optionWithCount(scopeLabel(option.value), option)}
                </option>
              {/each}
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Health</span>
            <select
              bind:value={inventoryFilters.healthStatus}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors focus:border-gold-400"
            >
              <option value={ALL_TOOL_FILTERS}>All health states ({inventoryTotalCount})</option>
              {#each inventoryFilterOptions.healthStatuses as option}
                <option value={option.value}>
                  {optionWithCount(healthStatusLabel(option.value), option)}
                </option>
              {/each}
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Chat Availability</span>
            <select
              bind:value={inventoryFilters.chatStatus}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors focus:border-gold-400"
            >
              <option value={ALL_TOOL_FILTERS}>All chat states ({inventoryTotalCount})</option>
              {#each inventoryFilterOptions.chatStatuses as option}
                <option value={option.value}>
                  {optionWithCount(availabilityStatusLabel(option.value), option)}
                </option>
              {/each}
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Heartbeat Availability</span>
            <select
              bind:value={inventoryFilters.heartbeatStatus}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors focus:border-gold-400"
            >
              <option value={ALL_TOOL_FILTERS}>All heartbeat states ({inventoryTotalCount})</option>
              {#each inventoryFilterOptions.heartbeatStatuses as option}
                <option value={option.value}>
                  {optionWithCount(availabilityStatusLabel(option.value), option)}
                </option>
              {/each}
            </select>
          </label>
        </div>
      </div>
    {/if}

    {#if loading}
      <div class="grid gap-4 lg:grid-cols-2">
        {#each Array(4) as _}
          <div class="card-garden animate-pulse p-5">
            <div class="h-4 w-40 rounded bg-bark-200"></div>
            <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
            <div class="mt-2 h-3 w-5/6 rounded bg-bark-100"></div>
            <div class="mt-5 grid gap-3 md:grid-cols-2">
              <div class="h-20 rounded-2xl bg-bark-100"></div>
              <div class="h-20 rounded-2xl bg-bark-100"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if filteredInventoryGroups.length}
      {#each filteredInventoryGroups as group}
        <section class="space-y-3">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-3">
              <span class="inline-block h-2.5 w-2.5 rounded-full {group.accent}"></span>
              <div>
                <h3 class="text-base font-semibold text-shadow-900">{group.title}</h3>
                <p class="text-sm text-shadow-600">{group.detail}</p>
              </div>
            </div>
            <div>
              <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-xs font-medium text-shadow-700">
                {group.tools.length} shown
              </span>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            {#each group.tools as tool}
              <ToolCard {tool} />
            {/each}
          </div>
        </section>
      {/each}
    {:else if inventoryGroups.length}
      <div class="card-garden border-l-4 border-l-gold-400 p-5">
        <h3 class="text-base font-serif font-semibold text-shadow-900">No tools match these filters</h3>
        <p class="mt-2 text-sm text-shadow-600">
          Adjust the search or selectors to widen the inventory view.
        </p>
        <button
          type="button"
          onclick={clearInventoryFilters}
          class="mt-4 rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100"
        >
          Clear filters
        </button>
      </div>
    {:else}
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-500">No tool health rows are available for this runtime.</p>
      </div>
    {/if}
  </section>

  <section class="space-y-4" aria-labelledby="tools-adaptive-runtime-heading">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Adaptive Runtime</p>
      <h2 id="tools-adaptive-runtime-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
        Activation snapshot
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        What the adaptive tool selector currently made active, promoted, or skipped.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
      <div class="card-garden p-5">
        <div class="flex items-baseline justify-between gap-4">
          <div>
            <h3 class="text-base font-serif font-semibold text-shadow-900">Runtime Snapshot</h3>
            <p class="mt-1 text-sm text-shadow-600">
              Catalog generated {formatTimestamp(data?.catalog?.generatedAt)}.
            </p>
          </div>
          {#if loading}
            <span class="text-sm text-shadow-500">Loading...</span>
          {/if}
        </div>

        {#if data?.state}
          <div class="mt-4 flex flex-wrap gap-2">
            {#each data.state.activeTools as tool}
              <span class="rounded-full border border-petal-200 bg-petal-50 px-3 py-1 text-xs font-medium text-petal-700">
                {tool.toolName} | {tool.source}
              </span>
            {/each}
            {#if data.state.activeTools.length === 0}
              <span class="text-sm text-shadow-500">No active tool snapshot available.</span>
            {/if}
          </div>
        {:else}
          <p class="mt-4 text-sm text-shadow-500">Adaptive tool telemetry is not available in this runtime.</p>
        {/if}
      </div>

      <div class="card-garden p-5">
        <h3 class="text-base font-serif font-semibold text-shadow-900">Promotion Notes</h3>
        {#if data?.state?.promotedToolsSkipped.length}
          <div class="mt-4 space-y-3">
            {#each data.state.promotedToolsSkipped as skip}
              <div class="rounded-2xl border border-gold-200 bg-gold-50 px-4 py-3">
                <div class="flex items-center justify-between gap-3">
                  <code class="text-sm font-medium text-shadow-900">{skip.toolName}</code>
                  <span class="rounded-full border border-gold-200 bg-white px-2 py-0.5 text-xs font-medium text-gold-700">
                    {skip.reason}
                  </span>
                </div>
                <p class="mt-2 text-sm text-shadow-600">Source: {skip.source}</p>
                {#if skip.missingTokens?.length}
                  <p class="mt-2 text-sm text-shadow-600">
                    Missing tokens: {skip.missingTokens.join(', ')}
                  </p>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-4 text-sm text-shadow-500">No promoted tools are currently being skipped.</p>
        {/if}
      </div>
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="tools-workflows-heading">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Workflows</p>
      <h2 id="tools-workflows-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
        Memory and social operations
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        Focused checks for tools and admin surfaces operators use when memory, focus, or contacts are involved.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
      <div class="card-garden p-5">
        <div class="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-base font-serif font-semibold text-shadow-900">Memory / Social Workflow</h3>
            <p class="mt-1 text-sm text-shadow-600">
              Spotlight on runtime tools that affect memory, focus, and contacts.
            </p>
          </div>
          <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-xs font-medium text-shadow-700">
            {memoryWorkflowTools.length} visible / {MEMORY_WORKFLOW_TOOL_NAMES.length} expected
          </span>
        </div>

        <div class="mt-4 space-y-3">
          {#if loading}
            <p class="text-sm text-shadow-500">Loading workflow tool visibility...</p>
          {:else if memoryWorkflowTools.length}
            {#each memoryWorkflowTools as tool}
              <ToolCard {tool} density="compact" />
            {/each}
          {:else}
            <p class="text-sm text-shadow-500">No memory-oriented tools are visible in the runtime catalog.</p>
          {/if}
        </div>

        {#if !loading && missingMemoryWorkflowTools.length > 0}
          <div class="mt-4 rounded-2xl border border-wilt-200 bg-wilt-50 px-4 py-3">
            <p class="text-sm font-medium text-wilt-700">Expected but not registered</p>
            <div class="mt-3 flex flex-wrap gap-2">
              {#each missingMemoryWorkflowTools as toolName}
                <span class="rounded-full border border-wilt-200 bg-white px-2.5 py-1 text-xs font-medium text-wilt-700">
                  {toolName}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="card-garden p-5">
        <h3 class="text-base font-serif font-semibold text-shadow-900">Admin Surfaces</h3>
        <p class="mt-1 text-sm text-shadow-600">
          The memory-system admin controls live across a few dedicated pages. These links keep them one click away from the runtime tool view.
        </p>
        <div class="mt-4 space-y-3">
          {#each MEMORY_ADMIN_LINKS as link}
            <a
              href={link.href}
              class="block rounded-2xl border border-bark-200 bg-bark-50 px-4 py-3 transition-colors hover:bg-bark-100"
            >
              <p class="text-sm font-medium text-shadow-900">{link.title}</p>
              <p class="mt-1 text-sm text-shadow-600">{link.detail}</p>
            </a>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="tools-failures-audit-heading">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Failures / Audit</p>
      <h2 id="tools-failures-audit-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
        Recent failures and telemetry trail
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        Latest error rows and adaptive selector events retained by admin telemetry.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
      <div class="card-garden p-5">
        <h3 class="text-base font-serif font-semibold text-shadow-900">Recent Failures</h3>
        {#if data?.recentFailures.length}
          <div class="mt-4 space-y-3">
            {#each data.recentFailures as failure}
              <FailureRow
                title={failure.toolName}
                message={failure.message}
                timestamp={failure.timestamp}
                meta={failure.channelId}
              />
            {/each}
          </div>
        {:else}
          <p class="mt-4 text-sm text-shadow-500">No recent tool failures have been observed.</p>
        {/if}
      </div>

      <div class="card-garden p-5">
        <h3 class="text-base font-serif font-semibold text-shadow-900">Adaptive Audit Events</h3>
        {#if recentTelemetry.length}
          <div class="mt-4 space-y-3">
            {#each recentTelemetry.slice(0, 8) as event}
              <div class="rounded-2xl border border-bark-200 bg-bark-50 px-4 py-3">
                <div class="flex items-center justify-between gap-3">
                  <code class="text-sm font-medium text-shadow-900">{telemetryEventTitle(event)}</code>
                  <span class="text-xs text-shadow-600">{formatTimestamp(event.timestamp)}</span>
                </div>
                <p class="mt-2 text-sm text-shadow-700">{telemetryEventDetail(event)}</p>
                <p class="mt-2 text-xs uppercase tracking-[0.16em] text-shadow-500">
                  {telemetryEventMeta(event)}
                </p>
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-4 text-sm text-shadow-500">No adaptive tool telemetry events have been retained yet.</p>
        {/if}
      </div>
    </div>

    <div class="card-garden p-5">
      <h3 class="text-base font-serif font-semibold text-shadow-900">Scope Note</h3>
      <p class="mt-4 text-sm leading-relaxed text-shadow-700">
        This page is derived from the direct runtime tool catalog and admin telemetry. Helpers that only exist inside
        <code class="rounded bg-bark-100 px-1.5 py-0.5 text-xs text-gold-700">think</code>
        are intentionally excluded because they are not registered as direct agent tools.
      </p>
    </div>
  </section>
</div>
