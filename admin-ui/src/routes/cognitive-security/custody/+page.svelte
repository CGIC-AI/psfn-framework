<script lang="ts">
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getCustodyChainForDelivery,
    getCustodyChainForTurn,
    getCustodySourceEgresses,
    type CustodyChainEgressToSourcesView,
    type CustodyChainSourceToEgressesView,
  } from '$lib/api/endpoints/custody';

  // Nothing on this page is content. Every value rendered below is an id, a
  // hash, a count, a closed-vocabulary label, a timestamp or an outcome —
  // the same discipline the stored records are held to.

  let chain = $state<CustodyChainEgressToSourcesView | null>(null);
  let sources = $state<CustodyChainSourceToEgressesView | null>(null);
  let chainInput = $state('');
  let sourceInput = $state('');
  let chainError = $state('');
  let sourceError = $state('');
  let chainLoading = $state(false);
  let sourceLoading = $state(false);

  const SHA256 = /^[a-f0-9]{64}$/u;

  function instant(value: number | 'unknown'): string {
    if (value === 'unknown') return 'unknown';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'unknown' : parsed.toLocaleString();
  }

  function short(digest: string): string {
    return digest.slice(0, 12);
  }

  async function loadChain() {
    const query = chainInput.trim();
    if (!query) {
      chainError = 'Enter a turn id or a delivery ref.';
      return;
    }
    chainLoading = true;
    chainError = '';
    try {
      // A delivery ref is `turn:<turnId>#<sha256>`; anything else is a turn id.
      chain = query.includes('#')
        ? await getCustodyChainForDelivery(query)
        : await getCustodyChainForTurn(query);
    } catch (e) {
      chain = null;
      chainError = e instanceof Error ? e.message : 'Failed to resolve the custody chain';
    } finally {
      chainLoading = false;
    }
  }

  async function loadSources(cursor?: string) {
    const query = sourceInput.trim();
    if (!query) {
      sourceError = 'Enter a source reference or its sha256 digest.';
      return;
    }
    sourceLoading = true;
    sourceError = '';
    try {
      sources = await getCustodySourceEgresses({
        ...(SHA256.test(query) ? { sourceDigest: query } : { sourceRef: query }),
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch (e) {
      sources = null;
      sourceError = e instanceof Error ? e.message : 'Failed to resolve the source history';
    } finally {
      sourceLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Cognitive Security: Chain of Custody</title>
</svelte:head>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Cognitive Security · Provenance"
    title="Chain of Custody"
    description="Which admitted context caused an egress, and where a source's bytes ended up. Ids, hashes, counts and outcomes only -- never message content."
  />

  <section class="card-garden p-5 space-y-4">
    <h2 class="text-sm font-semibold text-shadow-700">Egress &rarr; sources</h2>
    <div class="flex gap-2">
      <input
        bind:value={chainInput}
        placeholder="turn id, or turn:&lt;id&gt;#&lt;sha256&gt;"
        class="flex-1 text-sm px-3 py-1.5 rounded-lg border border-bark-300 font-mono"
      />
      <button
        onclick={loadChain}
        disabled={chainLoading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600
               hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
      >
        {chainLoading ? 'Resolving...' : 'Resolve'}
      </button>
    </div>
    {#if chainError}
      <p class="text-sm text-wilt-700">{chainError}</p>
    {/if}
    {#if chain}
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt class="text-shadow-500">Snapshot</dt><dd class="font-mono">{chain.snapshotStatus}</dd>
        <dt class="text-shadow-500">Manifest</dt><dd class="font-mono">{chain.manifestStatus}</dd>
        <dt class="text-shadow-500">Delivery</dt><dd class="font-mono">{chain.deliveryStatus}</dd>
        <dt class="text-shadow-500">Chain complete</dt><dd class="font-mono">{chain.chainComplete}</dd>
        <dt class="text-shadow-500">Classification</dt><dd class="font-mono">{chain.classification}</dd>
        <dt class="text-shadow-500">Sensitivity</dt><dd class="font-mono">{chain.effectiveSensitivity}</dd>
        <dt class="text-shadow-500">Sources</dt><dd class="font-mono">{chain.sourceCount}</dd>
        <dt class="text-shadow-500">Unclassified source</dt>
        <dd class="font-mono">{chain.hasUnclassifiedSource}</dd>
        <dt class="text-shadow-500">Deliveries</dt>
        <dd class="font-mono">{chain.deliveryCount} ({chain.heldDeliveryCount} held)</dd>
        <dt class="text-shadow-500">Unreadable rows</dt>
        <dd class="font-mono">{chain.malformedDeliveryCount}</dd>
      </dl>
      {#if chain.unknownDimensions.length > 0}
        <p class="text-sm text-gold-700">
          Unknown: {chain.unknownDimensions.join(', ')}
        </p>
      {/if}
      {#if chain.sources.length > 0}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-shadow-500">
              <tr>
                <th class="py-1 pr-3">Kind</th>
                <th class="py-1 pr-3">Ref</th>
                <th class="py-1 pr-3">Sensitivity</th>
                <th class="py-1 pr-3">Classified</th>
                <th class="py-1 pr-3">Admission</th>
                <th class="py-1 pr-3">Blocks</th>
              </tr>
            </thead>
            <tbody class="font-mono">
              {#each chain.sources as entry (entry.source.ref.digest)}
                <tr class="border-t border-bark-200">
                  <td class="py-1 pr-3">{entry.source.kind}</td>
                  <td class="py-1 pr-3">{entry.source.ref.id ?? short(entry.source.ref.digest)}</td>
                  <td class="py-1 pr-3">{entry.source.sensitivity}</td>
                  <td class="py-1 pr-3">{entry.source.classified}</td>
                  <td class="py-1 pr-3">
                    {entry.admission.status === 'present'
                      ? (entry.admission.receiptId
                        ?? entry.admission.envelopeId
                        ?? (entry.admission.contentSha256
                          ? short(entry.admission.contentSha256)
                          : 'present'))
                      : 'unknown'}
                  </td>
                  <td class="py-1 pr-3">{entry.renderedBlockCount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if chain.deliveries.length > 0}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-shadow-500">
              <tr>
                <th class="py-1 pr-3">Surface</th>
                <th class="py-1 pr-3">Disposition</th>
                <th class="py-1 pr-3">Outcome</th>
                <th class="py-1 pr-3">Destination</th>
                <th class="py-1 pr-3">Hold reason</th>
                <th class="py-1 pr-3">Content</th>
                <th class="py-1 pr-3">Recorded</th>
              </tr>
            </thead>
            <tbody class="font-mono">
              {#each chain.deliveries as delivery (delivery.deliveryRef)}
                <tr class="border-t border-bark-200">
                  <td class="py-1 pr-3">{delivery.surface}</td>
                  <td class="py-1 pr-3">{delivery.disposition}</td>
                  <td class="py-1 pr-3">{delivery.outcome}</td>
                  <td class="py-1 pr-3">{delivery.destination?.kind ?? 'unknown'}</td>
                  <td class="py-1 pr-3">{delivery.holdReason ?? '-'}</td>
                  <td class="py-1 pr-3">{short(delivery.contentSha256)}</td>
                  <td class="py-1 pr-3">{instant(delivery.recordedAtMs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </section>

  <section class="card-garden p-5 space-y-4">
    <h2 class="text-sm font-semibold text-shadow-700">Source &rarr; egresses</h2>
    <div class="flex gap-2">
      <input
        bind:value={sourceInput}
        placeholder="memory:&lt;id&gt;, wiki:&lt;id&gt;, or a sha256 digest"
        class="flex-1 text-sm px-3 py-1.5 rounded-lg border border-bark-300 font-mono"
      />
      <button
        onclick={() => loadSources()}
        disabled={sourceLoading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600
               hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
      >
        {sourceLoading ? 'Resolving...' : 'Resolve'}
      </button>
    </div>
    {#if sourceError}
      <p class="text-sm text-wilt-700">{sourceError}</p>
    {/if}
    {#if sources}
      <p class="text-sm text-shadow-600">
        {sources.generationCount} generation(s), {sources.deliveryCount} delivery record(s),
        {sources.heldDeliveryCount} held.
        {#if sources.unknownDimensions.length > 0}
          Unknown: {sources.unknownDimensions.join(', ')}.
        {/if}
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-shadow-500">
            <tr>
              <th class="py-1 pr-3">Turn</th>
              <th class="py-1 pr-3">Snapshot</th>
              <th class="py-1 pr-3">Classification</th>
              <th class="py-1 pr-3">Sensitivity</th>
              <th class="py-1 pr-3">Deliveries</th>
              <th class="py-1 pr-3">Classified</th>
            </tr>
          </thead>
          <tbody class="font-mono">
            {#each sources.generations as generation (generation.generationContextRef)}
              <tr class="border-t border-bark-200">
                <td class="py-1 pr-3">{generation.turnId}</td>
                <td class="py-1 pr-3">{generation.snapshotStatus}</td>
                <td class="py-1 pr-3">{generation.classification}</td>
                <td class="py-1 pr-3">{generation.effectiveSensitivity}</td>
                <td class="py-1 pr-3">{generation.deliveries.length}</td>
                <td class="py-1 pr-3">{instant(generation.classifiedAtMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if sources.page.hasMore && sources.page.nextCursor}
        <button
          onclick={() => loadSources(sources?.page.nextCursor)}
          disabled={sourceLoading}
          class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                 hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
        >
          Next page
        </button>
      {/if}
    {/if}
  </section>
</div>
