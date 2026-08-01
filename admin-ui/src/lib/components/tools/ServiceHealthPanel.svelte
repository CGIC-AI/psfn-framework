<script lang="ts">
  import type { RuntimeServiceHealth } from '$lib/types/tools';
  import { releaseMcp } from '$lib/api/endpoints/tools';
  import FailureRow from './FailureRow.svelte';
  import {
    availableActionSummary,
    formatTimestamp,
    HEALTH_BADGE,
    HEALTH_LABELS,
    SERVICE_LABELS,
  } from './tool-display';

  interface Props {
    service: RuntimeServiceHealth;
    onMcpChanged?: () => void | Promise<void>;
  }

  let { service, onMcpChanged }: Props = $props();
  let releasing = $state<string | null>(null);
  let lifecycleMessage = $state('');

  const actionSummary = $derived(availableActionSummary(service));

  async function unload(serverId?: string): Promise<void> {
    releasing = serverId ?? '*';
    lifecycleMessage = '';
    try {
      await releaseMcp(serverId);
      lifecycleMessage = serverId
        ? `Unloaded ${serverId}. It will reconnect lazily if selected again.`
        : 'Unloaded every MCP connection for this companion. They will reconnect lazily when selected.';
      await onMcpChanged?.();
    } catch (error) {
      lifecycleMessage = error instanceof Error ? error.message : 'MCP unload failed.';
    } finally {
      releasing = null;
    }
  }
</script>

<article class="card-garden p-5">
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

  {#if actionSummary}
    <p class="mt-3 rounded-xl border border-bark-200 bg-bark-50 px-3 py-2 text-xs text-shadow-700">
      {actionSummary}
    </p>
  {/if}

  {#if service.lastFailure}
    <div class="mt-4">
      <FailureRow
        title="Last failure"
        message={service.lastFailure.message}
        timestamp={service.lastFailure.at}
      />
    </div>
  {/if}

  {#if service.mcp}
    <div class="mt-4 space-y-3 border-t border-bark-200 pt-4">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-shadow-600">
          Screened server state
        </p>
        {#if service.mcp.activeSessions > 0}
          <button
            onclick={() => unload()}
            disabled={releasing !== null}
            class="rounded-lg border border-bark-300 px-2.5 py-1.5 text-xs font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50"
          >
            {releasing === '*' ? 'Unloading...' : 'Unload all'}
          </button>
        {/if}
      </div>
      {#each service.mcp.servers as server}
        <div class="rounded-xl border border-bark-200 bg-bark-50 p-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p class="text-sm font-medium text-shadow-800">{server.displayName}</p>
              <p class="font-mono text-xs text-shadow-500">{server.serverId}</p>
            </div>
            <div class="flex items-center gap-2 text-xs text-shadow-600">
              <span class="rounded-full border border-bark-300 px-2 py-1">{server.trustLevel}</span>
              <span>{server.hasLoadedTools ? 'schema loaded' : server.activeSession ? 'connected' : 'unloaded'}</span>
            </div>
          </div>
          <div class="mt-3 text-xs text-shadow-600">
            <p>
              Metadata: {server.metadata.disposition === 'passed' ? 'screened' : 'not scanned yet'}
              {#if server.metadata.toolCount !== undefined} · {server.metadata.toolCount} tools{/if}
            </p>
            {#if server.metadata.sha256}
              <p class="mt-1 break-all font-mono text-[0.7rem]">sha256:{server.metadata.sha256}</p>
            {/if}
          </div>
          {#if server.tools.length > 0}
            <div class="mt-3 flex flex-wrap gap-1.5">
              {#each server.tools as tool}
                <span class="rounded-md border border-bark-200 bg-white px-2 py-1 text-[0.7rem] text-shadow-600">
                  {tool.toolName} · {tool.effect} · confirm {tool.confirmation}
                </span>
              {/each}
            </div>
          {/if}
          {#if server.activeSession}
            <button
              onclick={() => unload(server.serverId)}
              disabled={releasing !== null}
              class="mt-3 rounded-lg border border-bark-300 px-2.5 py-1.5 text-xs font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50"
            >
              {releasing === server.serverId ? 'Unloading...' : 'Unload server'}
            </button>
          {/if}
        </div>
      {/each}
      {#if lifecycleMessage}
        <p class="text-xs text-shadow-700" aria-live="polite">{lifecycleMessage}</p>
      {/if}
    </div>
  {/if}
</article>
