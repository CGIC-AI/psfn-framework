<script lang="ts">
  type TelemetryTab = 'live' | 'audit';

  interface LinkAction {
    kind: 'link';
    href: string;
    label: string;
  }

  interface TabAction {
    kind: 'tab';
    tab: TelemetryTab;
    label: string;
  }

  interface AuditSurface {
    title: string;
    contextLabel: string;
    description: string;
    source: string;
    operatorQuestion: string;
    retention: string;
    actions: Array<LinkAction | TabAction>;
  }

  interface Props {
    activeTab: TelemetryTab;
    onSelectTelemetryTab: (tab: TelemetryTab) => void;
  }

  let {
    activeTab,
    onSelectTelemetryTab,
  }: Props = $props();

  const surfaces: AuditSurface[] = [
    {
      title: 'Telemetry Stream / Audit Trail',
      contextLabel: 'The Sap',
      description: 'Raw runtime event flow plus persisted audit history for tool use, activation failures, settings changes, charges, confirmations, external actions, and gateway policy decisions.',
      source: 'Garden audit JSONL, gateway audit store, charge ledger, and live admin telemetry',
      operatorQuestion: 'What just happened, and was it allowed or denied?',
      retention: 'Persistent audit history plus live overlay',
      actions: [
        { kind: 'tab', tab: 'live', label: 'Live Events' },
        { kind: 'tab', tab: 'audit', label: 'Audit Trail' },
      ],
    },
    {
      title: 'Prompt Monitor Turn Ledger / Raw Events',
      contextLabel: 'The Loom',
      description: 'Turn-level prompt assembly, provider wire shape, stage timings, selected-turn raw snapshot, and live channel bus payloads.',
      source: 'agent.turn.snapshot and agent.turn.stage',
      operatorQuestion: 'Which prompt, model route, context, tools, and provider payload produced this turn?',
      retention: 'Session turn history plus current live bus buffer',
      actions: [{ kind: 'link', href: '/prompt-monitor', label: 'Open Prompt Monitor' }],
    },
    {
      title: 'Contact Mutation Audit',
      contextLabel: 'The Visitors',
      description: 'Collapsed audit trail for contact trust, relationship, channel linkage, merge, and profile mutations.',
      source: 'contact mutation audit rows',
      operatorQuestion: 'Who changed this contact record, and what field changed?',
      retention: 'Backend persisted contact audit history',
      actions: [{ kind: 'link', href: '/contacts', label: 'Open Contacts' }],
    },
    {
      title: 'Session Compaction Audits',
      contextLabel: 'The Branches',
      description: 'Per-session compaction summaries, verification state, message ontology, and tool-call payload context.',
      source: 'session transcript and compaction audit views',
      operatorQuestion: 'What conversation content was folded, verified, or exposed to later turns?',
      retention: 'Session transcript storage',
      actions: [{ kind: 'link', href: '/sessions', label: 'Open Sessions' }],
    },
    {
      title: 'Tools Health / Failures',
      contextLabel: 'The Shed',
      description: 'Runtime service health, direct tool inventory, adaptive selector state, recent failures, and adaptive audit events.',
      source: 'tool catalog, health snapshots, and admin telemetry',
      operatorQuestion: 'Which tools are available, failing, skipped, or promoted right now?',
      retention: 'Runtime snapshot plus retained telemetry failures',
      actions: [{ kind: 'link', href: '/tools', label: 'Open Tools' }],
    },
    {
      title: 'Shards Review / Events',
      contextLabel: 'The Blooms',
      description: 'Shard lifecycle reconstruction from telemetry events, active/completed status, and recent raw shard event trail.',
      source: 'shard.* telemetry events',
      operatorQuestion: 'Which spawned shards ran, failed, completed, or need review?',
      retention: 'Telemetry-derived in-browser reconstruction',
      actions: [{ kind: 'link', href: '/shards', label: 'Open Shards' }],
    },
    {
      title: 'Confirmations Queue',
      contextLabel: 'The Gate',
      description: 'Pending approval queue for gated actions, with approve, deny, and modification paths before execution.',
      source: 'gateway confirmation queue',
      operatorQuestion: 'What security-sensitive action is waiting for operator approval?',
      retention: 'Gateway-backed pending queue',
      actions: [{ kind: 'link', href: '/confirmations', label: 'Open Confirmations' }],
    },
  ];

  function badgeTone(index: number): string {
    const tones = [
      'border-gold-200 bg-gold-50 text-gold-700',
      'border-moss-200 bg-moss-50 text-moss-700',
      'border-petal-200 bg-petal-50 text-petal-500',
      'border-bark-300 bg-bark-100 text-shadow-700',
    ];
    return tones[index % tones.length];
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="audit-surface-map-heading">
  <div class="border-b border-bark-300 bg-bark-100 px-5 py-4">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Observability map</p>
    <div class="mt-1 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id="audit-surface-map-heading" class="font-serif text-lg font-semibold text-shadow-900">
          Audit and observability surfaces
        </h2>
        <p class="mt-1 text-sm text-shadow-600">
          Operator directory for runtime events, persisted audits, and deeper review pages.
        </p>
      </div>
      <span class="rounded-full border border-bark-300 bg-white px-3 py-1 text-sm text-shadow-700">
        {surfaces.length} surfaces indexed
      </span>
    </div>
  </div>

  <div class="grid grid-cols-1 gap-3 p-4 xl:grid-cols-2">
    {#each surfaces as surface, index (surface.title)}
      <article class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-shadow-900">{surface.title}</h3>
            <p class="mt-1 text-xs text-shadow-500">{surface.contextLabel}</p>
          </div>
          <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${badgeTone(index)}`}>
            {surface.retention}
          </span>
        </div>

        <p class="mt-3 text-sm leading-relaxed text-shadow-700">{surface.description}</p>

        <dl class="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="font-medium text-shadow-900">Source</dt>
            <dd class="mt-1 text-shadow-600">{surface.source}</dd>
          </div>
          <div>
            <dt class="font-medium text-shadow-900">First question</dt>
            <dd class="mt-1 text-shadow-600">{surface.operatorQuestion}</dd>
          </div>
        </dl>

        <div class="mt-4 flex flex-wrap gap-2">
          {#each surface.actions as action (`${surface.title}-${action.label}`)}
            {#if action.kind === 'link'}
              <a
                href={action.href}
                class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:border-gold-300 hover:bg-gold-50 hover:text-shadow-900"
              >
                {action.label}
              </a>
            {:else}
              <button
                type="button"
                onclick={() => onSelectTelemetryTab(action.tab)}
                class="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors
                  {activeTab === action.tab
                    ? 'border-gold-300 bg-gold-50 text-shadow-900'
                    : 'border-bark-300 bg-bark-50 text-shadow-700 hover:border-gold-300 hover:bg-gold-50 hover:text-shadow-900'}"
              >
                {action.label}
              </button>
            {/if}
          {/each}
        </div>
      </article>
    {/each}
  </div>
</section>
