<script lang="ts">
  import type { AdminToolHealthView } from '$lib/types/tools';
  import FailureRow from './FailureRow.svelte';
  import {
    AVAILABILITY_BADGE,
    AVAILABILITY_LABELS,
    HEALTH_BADGE,
    HEALTH_LABELS,
  } from './tool-display';

  interface Props {
    tool: AdminToolHealthView;
    density?: 'compact' | 'full';
  }

  let {
    tool,
    density = 'full',
  }: Props = $props();

  const showFullDetail = $derived(density === 'full');
  const isControlSurface = $derived(
    tool.scope === 'core' && (tool.name === 'tool_search' || tool.name === 'toolset'),
  );
  const actionNames = $derived(tool.schema?.actions.map((action) => action.name) ?? []);
  const requiredParameters = $derived(tool.schema?.requiredParameters ?? []);
  const requiredCapabilities = $derived(tool.schema?.requiredCapabilities ?? []);
  const bundleMembership = $derived(tool.schema?.bundleMembership ?? []);
</script>

<article class="card-garden p-5">
  <div class="flex items-start justify-between gap-3">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <code class="text-sm font-medium text-shadow-900">{tool.name}</code>
        <span class="rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-xs font-medium text-shadow-600">
          {tool.scope}
        </span>
        {#if tool.scope === 'extended'}
          <span class="rounded-full border border-gold-200 bg-gold-50 px-2 py-0.5 text-xs font-medium text-gold-700">
            toolset member
          </span>
        {/if}
        {#if isControlSurface}
          <span class="rounded-full border border-moss-200 bg-moss-50 px-2 py-0.5 text-xs font-medium text-moss-700">
            control surface
          </span>
        {/if}
      </div>
      <p class="mt-3 text-sm leading-relaxed text-shadow-700">{tool.description}</p>
    </div>
    <span class="rounded-full border px-2.5 py-1 text-xs font-medium {HEALTH_BADGE[tool.health.status]}">
      {HEALTH_LABELS[tool.health.status]}
    </span>
  </div>

  {#if actionNames.length || requiredParameters.length || requiredCapabilities.length}
    <div class="mt-4 space-y-3">
      {#if actionNames.length}
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Actions</p>
          <div class="mt-2 flex flex-wrap gap-2">
            {#each actionNames as action}
              <code class="rounded-md border border-bark-200 bg-white px-2 py-1 text-xs text-shadow-800">{action}</code>
            {/each}
          </div>
        </div>
      {/if}

      {#if showFullDetail && (requiredParameters.length || requiredCapabilities.length)}
        <div class="grid gap-3 md:grid-cols-2">
          <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
            <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Required Params</p>
            <p class="mt-2 text-sm text-shadow-700">
              {requiredParameters.length ? requiredParameters.join(', ') : 'none'}
            </p>
          </div>
          <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
            <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Capabilities</p>
            <p class="mt-2 text-sm text-shadow-700">
              {requiredCapabilities.length ? requiredCapabilities.join(', ') : 'none'}
            </p>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if showFullDetail}
    <div class="mt-4 rounded-2xl border border-bark-200 bg-bark-50 px-3 py-3 text-sm text-shadow-700">
      {tool.health.detail}
    </div>
  {/if}

  {#if showFullDetail && tool.schema}
    <div class="mt-3 flex flex-wrap gap-2 text-xs">
      <span class="rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-shadow-600">
        {tool.schema.reversibility}
      </span>
      {#if tool.schema.interruptibility}
        <span class="rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-shadow-600">
          {tool.schema.interruptibility}
        </span>
      {/if}
      {#each bundleMembership as bundle}
        <span class="rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-shadow-600">
          {bundle}
        </span>
      {/each}
    </div>
  {/if}

  <div class="mt-4 grid gap-3 md:grid-cols-2">
    <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Chat</span>
        <span class="rounded-full border px-2 py-0.5 text-xs font-medium {AVAILABILITY_BADGE[tool.contexts.chat.status]}">
          {AVAILABILITY_LABELS[tool.contexts.chat.status]}
        </span>
      </div>
      {#if showFullDetail}
        <p class="mt-2 text-sm text-shadow-700">{tool.contexts.chat.detail}</p>
      {/if}
    </div>

    <div class="rounded-2xl border border-bark-200 bg-white px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Internal Heartbeat</span>
        <span class="rounded-full border px-2 py-0.5 text-xs font-medium {AVAILABILITY_BADGE[tool.contexts.internalHeartbeat.status]}">
          {AVAILABILITY_LABELS[tool.contexts.internalHeartbeat.status]}
        </span>
      </div>
      {#if showFullDetail}
        <p class="mt-2 text-sm text-shadow-700">{tool.contexts.internalHeartbeat.detail}</p>
      {/if}
    </div>
  </div>

  {#if showFullDetail && tool.lastFailure}
    <div class="mt-4">
      <FailureRow
        title="Recent failure"
        message={tool.lastFailure.message}
        timestamp={tool.lastFailure.timestamp}
      />
    </div>
  {/if}
</article>
