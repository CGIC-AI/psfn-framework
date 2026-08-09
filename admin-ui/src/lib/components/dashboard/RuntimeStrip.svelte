<script lang="ts">
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  let {
    schedulerTasks,
    activeShards,
    contextPressure,
    lastTtft,
    averageTtft,
  } = $props<{
    schedulerTasks: number;
    activeShards: number;
    contextPressure: {
      hasTelemetry: boolean;
      isOverLimit: boolean;
      utilizationPct: number;
    };
    lastTtft: string;
    averageTtft: string;
  }>();

  const items = $derived([
    {
      label: 'Scheduler tasks',
      value: schedulerTasks.toLocaleString(),
      hint: 'configured runtime tasks',
      href: scopeGardenPath('/scheduler'),
      warning: false,
    },
    {
      label: 'Active shards',
      value: activeShards.toLocaleString(),
      hint: activeShards === 0 ? 'no shard pressure' : 'currently active',
      href: scopeGardenPath('/shards'),
      warning: false,
    },
    {
      label: 'Context pressure',
      value: contextPressure.hasTelemetry ? `${contextPressure.utilizationPct.toFixed(0)}%` : '0%',
      hint: contextPressure.hasTelemetry
        ? contextPressure.isOverLimit
          ? 'over configured limit'
          : 'active session'
        : 'awaiting session telemetry',
      href: scopeGardenPath('/sessions'),
      warning: contextPressure.isOverLimit,
    },
    {
      label: 'Last TTFT',
      value: lastTtft,
      hint: `average ${averageTtft}`,
      href: scopeGardenPath('/sessions'),
      warning: false,
    },
  ]);
</script>

<section aria-label="Runtime vitals" class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-bark-300 bg-bark-300 shadow-sm">
  {#each items as item (item.label)}
    <a
      href={item.href}
      class="group min-h-28 bg-bark-50 px-3 py-3 transition-colors hover:bg-gold-50 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500 sm:px-4"
    >
      <p class="text-[10px] font-semibold uppercase tracking-[0.09em] text-shadow-600">{item.label}</p>
      <p class="mt-2 font-serif text-2xl leading-none tabular-nums {item.warning ? 'text-wilt-700' : 'text-shadow-900'}">
        {item.value}
      </p>
      <p class="mt-1 text-xs leading-snug {item.warning ? 'text-wilt-700' : 'text-shadow-500'}">{item.hint}</p>
    </a>
  {/each}
</section>
