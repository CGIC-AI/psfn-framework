<script lang="ts">
  import type { RuntimeServiceHealthStatus } from '$lib/types/tools';
  import {
    AVAILABILITY_BADGE,
    AVAILABILITY_LABELS,
    HEALTH_BADGE,
    HEALTH_LABELS,
  } from './tool-display';

  type AvailabilityStatus = keyof typeof AVAILABILITY_LABELS;

  interface ToolDiscoveryView {
    description: string;
    scope: 'core' | 'extended' | 'conditional';
    schema?: {
      actions: Array<{ name: string }>;
      requiredParameters: string[];
      requiredCapabilities: string[];
      bundleMembership: string[];
      reversibility: string;
      interruptibility?: string;
    };
    health: { status: RuntimeServiceHealthStatus; detail: string };
    contexts: {
      chat: { status: AvailabilityStatus; detail: string };
      internalHeartbeat: { status: AvailabilityStatus; detail: string };
    };
  }

  let { toolSearch, toolset } = $props<{
    toolSearch?: ToolDiscoveryView;
    toolset?: ToolDiscoveryView;
  }>();

  function actionNames(tool: ToolDiscoveryView | undefined): string[] {
    return tool?.schema?.actions.map((action: { name: string }) => action.name) ?? [];
  }

  function healthBadge(status: RuntimeServiceHealthStatus): string {
    return HEALTH_BADGE[status];
  }

  function healthLabel(status: RuntimeServiceHealthStatus): string {
    return HEALTH_LABELS[status];
  }

  function availabilityBadge(status: AvailabilityStatus): string {
    return AVAILABILITY_BADGE[status];
  }

  function availabilityLabel(status: AvailabilityStatus): string {
    return AVAILABILITY_LABELS[status];
  }

  const searchActions = $derived(actionNames(toolSearch));
  const managementActions = $derived(actionNames(toolset));
</script>

<article class="card-garden p-5" data-tool-surface="tool-search">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="font-mono text-sm font-medium text-shadow-900">Tool search</h3>
        <span class="rounded-full border border-moss-200 bg-moss-50 px-2 py-0.5 text-xs font-medium text-moss-700">
          canonical control surface
        </span>
      </div>
      <p class="mt-2 text-sm leading-relaxed text-shadow-700">
        Find callable tools and inspect their schemas here. Toolset ordering remains a management action inside this surface.
      </p>
    </div>
  </div>

  <div class="mt-4 grid gap-3 md:grid-cols-2">
    {#if toolSearch}
      <section class="rounded-xl border border-bark-200 bg-bark-50 px-4 py-3" aria-label="Tool search status">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Search actions</p>
            <span class="rounded-full border border-bark-200 px-2 py-0.5 text-xs text-shadow-500">{toolSearch.scope}</span>
          </div>
          <span class="rounded-full border px-2 py-0.5 text-xs font-medium {healthBadge(toolSearch.health.status)}">
            {healthLabel(toolSearch.health.status)}
          </span>
        </div>
        <p class="mt-2 text-sm text-shadow-700">{toolSearch.description}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          {#each searchActions as action}
            <code class="rounded-md border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-800">{action}</code>
          {/each}
        </div>
        <p class="mt-2 text-xs text-shadow-600">{toolSearch.health.detail}</p>
        {#if toolSearch.schema}
          <p class="mt-2 text-xs text-shadow-600">
            Params: {toolSearch.schema.requiredParameters.join(', ') || 'none'} · capabilities:
            {toolSearch.schema.requiredCapabilities.join(', ') || 'none'} · {toolSearch.schema.reversibility}
          </p>
        {/if}
        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          <span class="rounded-full border px-2 py-0.5 {availabilityBadge(toolSearch.contexts.chat.status)}">
            Chat: {availabilityLabel(toolSearch.contexts.chat.status)}
          </span>
          <span class="rounded-full border px-2 py-0.5 {availabilityBadge(toolSearch.contexts.internalHeartbeat.status)}">
            Reflection: {availabilityLabel(toolSearch.contexts.internalHeartbeat.status)}
          </span>
        </div>
      </section>
    {/if}

    {#if toolset}
      <section class="rounded-xl border border-bark-200 bg-bark-50 px-4 py-3" aria-label="Toolset management status">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Toolset management</p>
            <span class="rounded-full border border-bark-200 px-2 py-0.5 text-xs text-shadow-500">{toolset.scope}</span>
          </div>
          <span class="rounded-full border px-2 py-0.5 text-xs font-medium {healthBadge(toolset.health.status)}">
            {healthLabel(toolset.health.status)}
          </span>
        </div>
        <p class="mt-2 text-sm text-shadow-700">{toolset.description}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          {#each managementActions as action}
            <code class="rounded-md border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-800">{action}</code>
          {/each}
        </div>
        <p class="mt-2 text-xs text-shadow-600">{toolset.health.detail}</p>
        {#if toolset.schema}
          <p class="mt-2 text-xs text-shadow-600">
            Params: {toolset.schema.requiredParameters.join(', ') || 'none'} · capabilities:
            {toolset.schema.requiredCapabilities.join(', ') || 'none'} · {toolset.schema.reversibility}
          </p>
        {/if}
        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          <span class="rounded-full border px-2 py-0.5 {availabilityBadge(toolset.contexts.chat.status)}">
            Chat: {availabilityLabel(toolset.contexts.chat.status)}
          </span>
          <span class="rounded-full border px-2 py-0.5 {availabilityBadge(toolset.contexts.internalHeartbeat.status)}">
            Reflection: {availabilityLabel(toolset.contexts.internalHeartbeat.status)}
          </span>
        </div>
      </section>
    {/if}
  </div>
</article>
