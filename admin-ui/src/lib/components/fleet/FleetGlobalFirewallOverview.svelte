<script lang="ts">
  // Pure presentational projection of a content-free fleet CogSec overview
  // (waw5q). Extracted from FleetGlobalFirewall so the cluster-owned framing,
  // the empty-queue guarantee, and the aggregate rendering are unit-testable
  // without network mounts.

  import type { FleetCogSecOverview } from '$lib/types';

  interface Props {
    overview: FleetCogSecOverview;
    reachableCount: number;
  }

  let { overview, reachableCount }: Props = $props();

  const MODE_STYLES: Record<string, string> = {
    off: 'bg-bark-200 text-shadow-700',
    shadow: 'bg-gold-100 text-gold-700',
    enforce: 'bg-moss-100 text-moss-700',
  };

  function formatMs(ms: number): string {
    if (ms <= 0) return '—';
    if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${String(minutes)}m`;
    return `${String(Math.round(minutes / 60))}h`;
  }

  const outcomeTiles = $derived([
    ['Held', overview.outcomeCounts.held],
    ['Released sanitized', overview.outcomeCounts.releasedSanitized],
    ['Released raw', overview.outcomeCounts.releasedRaw],
    ['Discarded', overview.outcomeCounts.discarded],
    ['Expired', overview.outcomeCounts.expired],
    ['Cleared', overview.outcomeCounts.cleared],
    ['Blocked egress', overview.outcomeCounts.blockedEgress],
  ] as const);
</script>

<section class="space-y-6">
  <section class="card-garden p-5" aria-label="Shared firewall policy">
    <div class="flex flex-wrap items-center gap-3">
      <span class="text-xs uppercase font-semibold text-shadow-600">Shared mode</span>
      <span
        class="inline-block px-3 py-1 rounded-full text-sm font-semibold test-firewall-mode {MODE_STYLES[overview.policyStatus.mode] ?? 'bg-bark-200 text-shadow-700'}"
      >
        {overview.policyStatus.mode}
      </span>
      <span class="text-xs text-shadow-500">
        TTL {overview.policyStatus.quarantineItemTtlHours}h · max held {overview.policyStatus.quarantineMaxHeldItems}
      </span>
    </div>
    <p class="mt-3 text-sm text-shadow-600 test-mode-note">
      {overview.policyStatus.mode === 'enforce'
        ? 'Sink gates enforce screening decisions; quarantined content is withheld.'
        : overview.policyStatus.mode === 'shadow'
          ? 'Observe-only: envelopes are screened and journaled, nothing is withheld.'
          : 'No intake screening is enforced anywhere; turn it on via intake-policy.'}
    </p>
  </section>

  <section class="card-garden border-l-4 border-l-moss-300 p-4 test-empty-guarantee">
    <p class="text-sm text-shadow-800">
      An empty approval queue <strong>never</strong> means the firewall is off. The shared mode
      above is authoritative and independent of any companion's queue contents.
    </p>
  </section>

  <section class="card-garden p-5" aria-label="Aggregate outcomes">
    <h3 class="font-serif text-lg text-shadow-900">Aggregate outcomes (content-free)</h3>
    <p class="text-xs text-shadow-500 mt-1 mb-3 test-authorized-scope">
      Authorized scope: {String(reachableCount)} companion{reachableCount === 1 ? '' : 's'}
      ({overview.companionScope.displayNames.join(', ') || 'none reachable'}).
    </p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {#each outcomeTiles as [label, count] (label)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3 text-center">
          <p class="text-2xl font-serif text-shadow-900 test-outcome-{label.toLowerCase().replace(/\s+/g, '-')}">{count}</p>
          <p class="mt-1 text-xs text-shadow-600">{label}</p>
        </div>
      {/each}
    </div>
  </section>

  <section class="grid grid-cols-1 gap-4 md:grid-cols-2">
    <div class="card-garden p-5">
      <h3 class="font-serif text-lg text-shadow-900">Decision latency</h3>
      <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 mt-2">
        <div><dt class="text-xs uppercase text-shadow-500">Decided</dt><dd class="font-mono test-latency-decided">{overview.latency.decidedCount}</dd></div>
        <div><dt class="text-xs uppercase text-shadow-500">Median</dt><dd class="font-mono test-latency-median">{formatMs(overview.latency.medianDecisionMs)}</dd></div>
        <div><dt class="text-xs uppercase text-shadow-500">p95</dt><dd class="font-mono">{formatMs(overview.latency.p95DecisionMs)}</dd></div>
        <div><dt class="text-xs uppercase text-shadow-500">Max</dt><dd class="font-mono">{formatMs(overview.latency.maxDecisionMs)}</dd></div>
      </dl>
    </div>
    <div class="card-garden p-5">
      <h3 class="font-serif text-lg text-shadow-900">Group fanout correlation</h3>
      <dl class="grid grid-cols-3 gap-3 text-sm mt-2">
        <div><dt class="text-xs uppercase text-shadow-500">Groups</dt><dd class="font-mono test-correlation-groups">{overview.correlation.groupCount}</dd></div>
        <div><dt class="text-xs uppercase text-shadow-500">Members</dt><dd class="font-mono">{overview.correlation.totalMembers}</dd></div>
        <div><dt class="text-xs uppercase text-shadow-500">Largest</dt><dd class="font-mono">{overview.correlation.largestGroup}</dd></div>
      </dl>
    </div>
  </section>
</section>
