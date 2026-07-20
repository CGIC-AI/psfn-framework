<script lang="ts">
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import type { AdminChargeLedgerData } from '$lib/api/endpoints/charges';
  import type { FatiguePolicyConfig } from '../../../../src/shared/contracts/charge-policy.js';

  let {
    data,
    policy,
  }: {
    data: AdminChargeLedgerData['humanAttention'] | null;
    policy: FatiguePolicyConfig['humanAttention'] | null;
  } = $props();

  function formatInteger(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '0';
    return new Intl.NumberFormat('en-US').format(value);
  }

  function formatTime(timestampMs: number | undefined): string {
    if (!timestampMs) return '-';
    return new Date(timestampMs).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function labelize(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="human-attention-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Companion boundaries</p>
    <h2 id="human-attention-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">
      Human attention pressure
    </h2>
    <p class="mt-1 text-sm text-shadow-600">
      Separate from MI fatigue. Threshold events add private context to the companion's normal turn; they never silence a human or send canned boundary text.
    </p>
  </div>
  <div class="grid gap-4 p-5 md:grid-cols-3">
    <div class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Policy</p>
      <p class="mt-2 font-serif text-xl font-semibold text-shadow-900">
        {policy?.enabled ? 'Enabled' : 'Disabled'}
      </p>
      <p class="mt-1 text-sm text-shadow-600">
        Window {formatInteger((policy?.windowMs ?? 0) / 60_000)} min · cooldown {formatInteger((policy?.boundaryCooldownMs ?? 0) / 60_000)} min
      </p>
    </div>
    <div class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Recorded pressure</p>
      <p class="mt-2 font-serif text-xl font-semibold text-shadow-900">
        {formatInteger(data?.aggregates.eventCount)}
      </p>
      <p class="mt-1 text-sm text-shadow-600">
        {formatInteger(data?.aggregates.boundaryAlertCount)} boundary alerts
      </p>
    </div>
    <div class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Trust thresholds</p>
      <p class="mt-2 font-mono text-sm text-shadow-800">
        public {policy?.trustThresholds.public ?? '-'} · regular {policy?.trustThresholds.regular ?? '-'}
      </p>
      <p class="mt-1 font-mono text-sm text-shadow-800">
        trusted {policy?.trustThresholds.trusted ?? '-'} · primary {policy?.trustThresholds.primary ?? '-'}
      </p>
    </div>
  </div>
  <BoundedList maxHeight="16rem" label="Recent human attention pressure events">
    <div class="divide-y divide-bark-200 border-t border-bark-200">
      {#each data?.events ?? [] as entry (entry.eventId)}
        <div class="grid gap-2 px-5 py-3 text-sm md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p class="font-medium text-shadow-800">
              {labelize(entry.event.decision)} · {labelize(entry.event.channelContext)}
            </p>
            <p class="mt-1 font-mono text-xs text-shadow-500">
              contact {shortId(entry.event.contactId)} · channel {shortId(entry.event.channelId)}
            </p>
          </div>
          <div class="md:text-right">
            <p class="text-shadow-800">{entry.event.pressureInWindow} / {entry.event.threshold}</p>
            <p class="text-xs text-shadow-500">{formatTime(entry.event.timestampMs)}</p>
          </div>
        </div>
      {:else}
        <p class="px-5 py-4 text-sm text-shadow-600">No human attention pressure events recorded.</p>
      {/each}
    </div>
  </BoundedList>
</section>
