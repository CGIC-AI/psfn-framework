<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { getAdaptiveTools } from '$lib/api/endpoints/tools';
  import type {
    AdminAdaptiveToolsData,
    AdminToolAvailabilityStatus,
    AdminToolHealthView,
    RuntimeServiceHealth,
    RuntimeServiceHealthStatus,
  } from '$lib/types/tools';

  type ToolScope = AdminToolHealthView['scope'];

  const SCOPE_ORDER: ToolScope[] = ['core', 'extended', 'conditional'];
  const SCOPE_META: Record<ToolScope, { title: string; detail: string; accent: string }> = {
    core: {
      title: 'Core Tools',
      detail: 'Always registered in the runtime catalog.',
      accent: 'bg-moss-400',
    },
    extended: {
      title: 'Extended Tools',
      detail: 'Registered runtime tools that can be loaded or promoted as needed.',
      accent: 'bg-gold-400',
    },
    conditional: {
      title: 'Conditional Tools',
      detail: 'Derived rows for runtime-backed tools that are unavailable in this mode.',
      accent: 'bg-wilt-400',
    },
  };

  const SERVICE_LABELS: Record<RuntimeServiceHealth['serviceId'], string> = {
    gateway: 'Gateway RPC',
    vault: 'Vault',
    ntfy: 'ntfy',
  };

  const HEALTH_LABELS: Record<RuntimeServiceHealthStatus, string> = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    unavailable: 'Unavailable',
    not_applicable: 'N/A',
  };

  const HEALTH_BADGE: Record<RuntimeServiceHealthStatus, string> = {
    healthy: 'border-moss-300 bg-moss-100 text-moss-700',
    degraded: 'border-gold-300 bg-gold-100 text-gold-700',
    unavailable: 'border-wilt-300 bg-wilt-100 text-wilt-700',
    not_applicable: 'border-bark-300 bg-bark-100 text-shadow-700',
  };

  const AVAILABILITY_LABELS: Record<AdminToolAvailabilityStatus, string> = {
    active: 'Active',
    available: 'Available',
    unavailable: 'Unavailable',
    not_applicable: 'N/A',
  };

  const AVAILABILITY_BADGE: Record<AdminToolAvailabilityStatus, string> = {
    active: 'border-petal-300 bg-petal-100 text-petal-700',
    available: 'border-moss-300 bg-moss-100 text-moss-700',
    unavailable: 'border-wilt-300 bg-wilt-100 text-wilt-700',
    not_applicable: 'border-bark-300 bg-bark-100 text-shadow-700',
  };

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

  let toolGroups = $derived.by(() => {
    const tools = data?.toolHealth ?? [];
    return SCOPE_ORDER
      .map((scope) => ({
        scope,
        ...SCOPE_META[scope],
        tools: tools.filter((tool) => tool.scope === scope),
      }))
      .filter((group) => group.tools.length > 0);
  });

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

  function formatTimestamp(timestamp: number | undefined): string {
    if (!Number.isFinite(timestamp)) return 'Unknown';
    return new Date(timestamp as number).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function availableActionSummary(service: RuntimeServiceHealth): string | null {
    if (!service.availableActions?.length) return null;
    return `Enabled actions: ${service.availableActions.join(', ')}`;
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Shed</h1>
      <p class="mt-1 text-sm text-shadow-600">
        Direct runtime tool availability and health derived from the live agent catalog.
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

  <div class="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
    <div class="card-garden p-5">
      <div class="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-lg font-serif font-semibold text-shadow-900">Memory / Social Workflow</h2>
          <p class="mt-1 text-sm text-shadow-600">
            Spotlight on the runtime tools that affect memory, focus, and contacts.
          </p>
        </div>
        <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-xs font-medium text-shadow-700">
          {memoryWorkflowTools.length} visible / {MEMORY_WORKFLOW_TOOL_NAMES.length} expected
        </span>
      </div>

      <div class="mt-4 space-y-3">
        {#each memoryWorkflowTools as tool}
          <div class="rounded-2xl border border-bark-200 bg-bark-50 px-4 py-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <code class="text-sm font-medium text-shadow-900">{tool.name}</code>
                <p class="mt-1 text-sm text-shadow-700">{tool.description}</p>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-medium {HEALTH_BADGE[tool.health.status]}">
                {HEALTH_LABELS[tool.health.status]}
              </span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2 text-xs">
              <span class="rounded-full border border-bark-300 bg-white px-2.5 py-1 text-shadow-700">
                scope: {tool.scope}
              </span>
              <span class="rounded-full border px-2.5 py-1 {AVAILABILITY_BADGE[tool.contexts.chat.status]}">
                chat: {AVAILABILITY_LABELS[tool.contexts.chat.status]}
              </span>
              <span class="rounded-full border px-2.5 py-1 {AVAILABILITY_BADGE[tool.contexts.internalHeartbeat.status]}">
                heartbeat: {AVAILABILITY_LABELS[tool.contexts.internalHeartbeat.status]}
              </span>
            </div>
          </div>
        {/each}
        {#if memoryWorkflowTools.length === 0}
          <p class="text-sm text-shadow-500">No memory-oriented tools are visible in the runtime catalog.</p>
        {/if}
      </div>

      {#if missingMemoryWorkflowTools.length > 0}
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
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Admin Surfaces</h2>
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

  <div class="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
    <div class="card-garden p-5">
      <div class="flex items-baseline justify-between gap-4">
        <div>
          <h2 class="text-lg font-serif font-semibold text-shadow-900">Runtime Snapshot</h2>
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
              {tool.toolName} · {tool.source}
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
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Promotion Notes</h2>
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

  <div>
    <div class="mb-4 flex items-baseline gap-3">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Service Health</h2>
      <span class="text-sm text-shadow-600">{data?.serviceHealth.length ?? 0} runtime dependencies</span>
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
          <div class="card-garden p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold uppercase tracking-[0.16em] text-shadow-500">
                  {SERVICE_LABELS[service.serviceId]}
                </h3>
                <p class="mt-1 text-xs text-shadow-500">Checked {formatTimestamp(service.checkedAt)}</p>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-medium {HEALTH_BADGE[service.status]}">
                {HEALTH_LABELS[service.status]}
              </span>
            </div>
            <p class="mt-4 text-sm leading-relaxed text-shadow-700">{service.detail}</p>
            {#if availableActionSummary(service)}
              <p class="mt-3 rounded-xl border border-bark-200 bg-bark-50 px-3 py-2 text-xs text-shadow-700">
                {availableActionSummary(service)}
              </p>
            {/if}
            {#if service.lastFailure}
              <div class="mt-4 rounded-2xl border border-wilt-200 bg-wilt-50 px-3 py-3">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-xs font-semibold uppercase tracking-[0.16em] text-wilt-700">Last failure</span>
                  <span class="text-xs text-wilt-700">{formatTimestamp(service.lastFailure.at)}</span>
                </div>
                <p class="mt-2 text-sm text-wilt-700">{service.lastFailure.message}</p>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-500">No runtime service health data is available.</p>
      </div>
    {/if}
  </div>

  <div class="space-y-5">
    <div class="flex items-baseline gap-3">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Tool Health</h2>
      <span class="text-sm text-shadow-600">{data?.toolHealth.length ?? 0} runtime-derived rows</span>
    </div>

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
    {:else if toolGroups.length}
      {#each toolGroups as group}
        <section class="space-y-3">
          <div class="flex items-center gap-3">
            <span class="inline-block h-2.5 w-2.5 rounded-full {group.accent}"></span>
            <div>
              <h3 class="text-base font-semibold text-shadow-900">{group.title}</h3>
              <p class="text-sm text-shadow-600">{group.detail}</p>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            {#each group.tools as tool}
              <div class="card-garden p-5">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="flex flex-wrap items-center gap-2">
                      <code class="text-sm font-medium text-shadow-900">{tool.name}</code>
                      <span class="rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-xs font-medium text-shadow-600">
                        {tool.scope}
                      </span>
                    </div>
                    <p class="mt-3 text-sm leading-relaxed text-shadow-700">{tool.description}</p>
                  </div>
                  <span class="rounded-full border px-2.5 py-1 text-xs font-medium {HEALTH_BADGE[tool.health.status]}">
                    {HEALTH_LABELS[tool.health.status]}
                  </span>
                </div>

                <div class="mt-4 rounded-2xl border border-bark-200 bg-bark-50 px-3 py-3 text-sm text-shadow-700">
                  {tool.health.detail}
                </div>

                <div class="mt-4 grid gap-3 md:grid-cols-2">
                  <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Chat</span>
                      <span class="rounded-full border px-2 py-0.5 text-xs font-medium {AVAILABILITY_BADGE[tool.contexts.chat.status]}">
                        {AVAILABILITY_LABELS[tool.contexts.chat.status]}
                      </span>
                    </div>
                    <p class="mt-2 text-sm text-shadow-700">{tool.contexts.chat.detail}</p>
                  </div>

                  <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Internal Heartbeat</span>
                      <span class="rounded-full border px-2 py-0.5 text-xs font-medium {AVAILABILITY_BADGE[tool.contexts.internalHeartbeat.status]}">
                        {AVAILABILITY_LABELS[tool.contexts.internalHeartbeat.status]}
                      </span>
                    </div>
                    <p class="mt-2 text-sm text-shadow-700">{tool.contexts.internalHeartbeat.detail}</p>
                  </div>
                </div>

                {#if tool.lastFailure}
                  <div class="mt-4 rounded-2xl border border-wilt-200 bg-wilt-50 px-4 py-3">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-xs font-semibold uppercase tracking-[0.16em] text-wilt-700">Recent failure</span>
                      <span class="text-xs text-wilt-700">{formatTimestamp(tool.lastFailure.timestamp)}</span>
                    </div>
                    <p class="mt-2 text-sm text-wilt-700">{tool.lastFailure.message}</p>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {:else}
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-500">No tool health rows are available for this runtime.</p>
      </div>
    {/if}
  </div>

  <div class="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
    <div class="card-garden p-5">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Recent Failures</h2>
      {#if data?.recentFailures.length}
        <div class="mt-4 space-y-3">
          {#each data.recentFailures as failure}
            <div class="rounded-2xl border border-wilt-200 bg-wilt-50 px-4 py-3">
              <div class="flex items-center justify-between gap-3">
                <code class="text-sm font-medium text-wilt-700">{failure.toolName}</code>
                <span class="text-xs text-wilt-700">{formatTimestamp(failure.timestamp)}</span>
              </div>
              <p class="mt-2 text-sm text-wilt-700">{failure.message}</p>
              <p class="mt-2 text-xs uppercase tracking-[0.16em] text-wilt-600">{failure.channelId}</p>
            </div>
          {/each}
        </div>
      {:else}
        <p class="mt-4 text-sm text-shadow-500">No recent tool failures have been observed.</p>
      {/if}
    </div>

    <div class="card-garden p-5">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Scope Note</h2>
      <p class="mt-4 text-sm leading-relaxed text-shadow-700">
        This page is derived from the direct runtime tool catalog and admin telemetry. Helpers that only exist inside
        <code class="rounded bg-bark-100 px-1.5 py-0.5 text-xs text-gold-700">think</code>
        are intentionally excluded because they are not registered as direct agent tools.
      </p>
    </div>
  </div>
</div>
