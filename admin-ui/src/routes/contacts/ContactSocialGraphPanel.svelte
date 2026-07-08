<script lang="ts">
  import type {
    AdminContactSocialGraphConnectionView,
    AdminContactSocialGraphView,
  } from '$lib/types';

  type BadgeStyle = { bg: string; text: string; label: string };

  interface Props {
    graph: AdminContactSocialGraphView | undefined;
    formatConfidence: (value: number) => string;
    formatGraphDirection: (connection: AdminContactSocialGraphConnectionView) => string;
    formatRelType: (rt: string) => string;
    formatTimestamp: (ts: number) => string;
    graphSourceLabel: (source: string) => string;
    trustBadge: (trust: string) => BadgeStyle;
  }

  let {
    graph,
    formatConfidence,
    formatGraphDirection,
    formatRelType,
    formatTimestamp,
    graphSourceLabel,
    trustBadge,
  }: Props = $props();
</script>

<div class="border-t border-bark-200 pt-2">
  <div class="flex items-center justify-between gap-2 mb-2">
    <p class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Social Graph</p>
    {#if graph?.entity}
      <span class="text-xs text-shadow-600">
        {graph.edgeCount} edge{graph.edgeCount === 1 ? '' : 's'}
        · {graph.neighborCount} neighbor{graph.neighborCount === 1 ? '' : 's'}
      </span>
    {/if}
  </div>

  {#if graph?.entity}
    <div class="rounded-xl border border-bark-200 bg-bark-50/70 p-3 space-y-2">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-shadow-900 truncate">{graph.entity.displayName}</p>
          <div class="flex flex-wrap items-center gap-1.5 mt-1">
            <span class="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-medium text-shadow-700 border border-bark-200">
              {graphSourceLabel(graph.entity.source)}
            </span>
            <span class="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-medium text-shadow-700 border border-bark-200">
              {graph.entity.sensitivity}
            </span>
            <span class="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-medium text-shadow-700 border border-bark-200">
              {formatConfidence(graph.entity.confidence)} confidence
            </span>
          </div>
        </div>
        <code class="font-mono text-[11px] text-shadow-500 text-right break-all">{graph.entity.id}</code>
      </div>

      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-shadow-600">
        <span>{graph.evidenceCount} evidence ref{graph.evidenceCount === 1 ? '' : 's'}</span>
        <span>{graph.provenanceCount} provenance ref{graph.provenanceCount === 1 ? '' : 's'}</span>
        {#if graph.mentionOnlyNeighborCount > 0}
          <span>{graph.mentionOnlyNeighborCount} mention-only neighbor{graph.mentionOnlyNeighborCount === 1 ? '' : 's'}</span>
        {/if}
      </div>

      {#if graph.entity.provenanceRefs.length > 0}
        <details>
          <summary class="text-sm text-shadow-600 cursor-pointer hover:text-gold-600 transition-colors">
            Entity provenance
          </summary>
          <div class="mt-1 flex flex-wrap gap-1">
            {#each graph.entity.provenanceRefs as ref}
              <span class="rounded bg-white px-1.5 py-0.5 text-xs text-shadow-700 border border-bark-200 break-all">{ref}</span>
            {/each}
          </div>
        </details>
      {/if}
    </div>

    {#if graph.connections.length > 0}
      <div class="mt-2 space-y-2">
        {#each graph.connections as connection (connection.edgeId)}
          <div class="rounded-xl border border-bark-200 p-3 bg-white/70">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium text-shadow-900 truncate">{connection.neighbor.displayName}</p>
                <div class="mt-1 flex flex-wrap items-center gap-1.5">
                  <span class="inline-flex items-center rounded-full bg-gold-50 px-2 py-0.5 text-xs font-medium text-gold-800 border border-gold-200">
                    {formatRelType(connection.relationshipType)}
                  </span>
                  <span class="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-medium text-shadow-700 border border-bark-200">
                    {formatGraphDirection(connection)}
                  </span>
                  {#if connection.neighbor.trustLevel}
                    {@const neighborBadge = trustBadge(connection.neighbor.trustLevel)}
                    <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                      style="{neighborBadge.bg}; {neighborBadge.text}">
                      {neighborBadge.label}
                    </span>
                  {/if}
                  {#if connection.neighbor.relationshipType}
                    <span class="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-medium text-shadow-700 border border-bark-200">
                      {formatRelType(connection.neighbor.relationshipType)}
                    </span>
                  {/if}
                  {#if connection.neighbor.mentionOnly}
                    <span class="inline-flex items-center rounded-full bg-moss-50 px-2 py-0.5 text-xs font-medium text-moss-800 border border-moss-200">
                      Mention-only contact
                    </span>
                  {/if}
                  {#if !connection.neighbor.contactId}
                    <span class="inline-flex items-center rounded-full bg-shadow-100 px-2 py-0.5 text-xs font-medium text-shadow-700 border border-shadow-200">
                      Unlinked entity
                    </span>
                  {/if}
                </div>
              </div>
              <div class="text-right text-xs text-shadow-600 shrink-0">
                <div>{formatConfidence(connection.confidence)} edge confidence</div>
                <div>{connection.sensitivity}</div>
              </div>
            </div>

            {#if connection.neighbor.profileSummary}
              <p class="mt-2 text-sm text-shadow-700 leading-relaxed italic">
                {connection.neighbor.profileSummary}
              </p>
              {#if connection.neighbor.profileUpdatedAt}
                <p class="mt-1 text-xs text-shadow-500">
                  Profile updated {formatTimestamp(connection.neighbor.profileUpdatedAt)}
                </p>
              {/if}
            {/if}

            <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-shadow-600">
              <span>{graphSourceLabel(connection.neighbor.source)} entity</span>
              <span>{formatConfidence(connection.neighbor.confidence)} entity confidence</span>
              {#if connection.neighbor.contactId}
                <span class="font-mono break-all">{connection.neighbor.contactId}</span>
              {/if}
            </div>

            {#if connection.evidenceMemoryIds.length > 0}
              <details class="mt-2">
                <summary class="text-sm text-shadow-600 cursor-pointer hover:text-gold-600 transition-colors">
                  Evidence memories ({connection.evidenceMemoryIds.length})
                </summary>
                <div class="mt-1 flex flex-wrap gap-1">
                  {#each connection.evidenceMemoryIds as memId}
                    <a
                      href="/memory?id={encodeURIComponent(memId)}"
                      class="text-sm bg-bark-200 px-1.5 py-0.5 rounded text-gold-700 hover:bg-gold-100 hover:text-gold-800 transition-colors font-mono break-all"
                      title="View memory {memId}"
                    >{memId}</a>
                  {/each}
                </div>
              </details>
            {/if}

            {#if connection.provenanceRefs.length > 0 || connection.neighbor.provenanceRefs.length > 0}
              <details class="mt-2">
                <summary class="text-sm text-shadow-600 cursor-pointer hover:text-gold-600 transition-colors">
                  Provenance
                </summary>
                <div class="mt-1 space-y-1">
                  {#if connection.provenanceRefs.length > 0}
                    <div>
                      <p class="text-xs font-medium uppercase tracking-wider text-shadow-500">Edge</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#each connection.provenanceRefs as ref}
                          <span class="rounded bg-bark-100 px-1.5 py-0.5 text-xs text-shadow-700 border border-bark-200 break-all">{ref}</span>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if connection.neighbor.provenanceRefs.length > 0}
                    <div>
                      <p class="text-xs font-medium uppercase tracking-wider text-shadow-500">Neighbor entity</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#each connection.neighbor.provenanceRefs as ref}
                          <span class="rounded bg-bark-100 px-1.5 py-0.5 text-xs text-shadow-700 border border-bark-200 break-all">{ref}</span>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              </details>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <p class="mt-2 text-sm text-shadow-600 italic">
        Graph entity exists, but no relationship edges have been recorded yet.
      </p>
    {/if}
  {:else}
    <p class="text-sm text-shadow-600 italic">
      No social graph entity has been materialized for this contact yet.
    </p>
  {/if}
</div>
