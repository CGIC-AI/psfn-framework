<script lang="ts">
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  interface GuideLink {
    label: string;
    path: string;
    fleetLevel?: boolean;
  }

  interface GuideLocation {
    title: string;
    description: string;
    links: GuideLink[];
  }

  interface GuideFlow {
    title: string;
    steps: string[];
    links: GuideLink[];
  }

  const locations: GuideLocation[] = [
    {
      title: 'Start and converse',
      description: 'Dashboard summarizes the current companion. Chat is the operator conversation console; Sessions browses retained conversations; Prompt Monitor (the Loom) explains one turn from prompt and context through tools, provider, and timing.',
      links: [
        { label: 'Dashboard', path: '/' },
        { label: 'Chat', path: '/chat' },
        { label: 'Sessions', path: '/sessions' },
        { label: 'Prompt Monitor', path: '/prompt-monitor' },
      ],
    },
    {
      title: 'Memory and people',
      description: 'Memory exposes durable memory records and safe operator metadata. L0.1 Episodes shows episodic landmarks and arcs. Contacts (the Visitors) owns canonical people, linked channel identities, trust, and relationship state.',
      links: [
        { label: 'Memory', path: '/memory' },
        { label: 'L0.1 Episodes', path: '/episodic-memory' },
        { label: 'Contacts', path: '/contacts' },
      ],
    },
    {
      title: 'Skills and configuration',
      description: 'Skills shows what was discovered, loaded, skipped, and injected. Settings edits the canonical owner files; the floating Save Settings control stays visible and reports dirty, saving, and last-saved state.',
      links: [
        { label: 'Skills', path: '/skills' },
        { label: 'Settings', path: '/settings' },
      ],
    },
    {
      title: 'Cognitive Security',
      description: 'Approvals is the human quarantine queue. Firewall shows enforcement mode, source tiers and lists, escalation thresholds, sink gates, and recent CogSec events.',
      links: [
        { label: 'Approvals', path: '/cognitive-security/approvals' },
        { label: 'Firewall', path: '/cognitive-security/firewall' },
      ],
    },
    {
      title: 'Usage and cost',
      description: 'Dashboard has the quick current-companion totals. Token Usage provides the detailed per-companion accounting cockpit; Cluster Costs compares authorized companions and cluster totals.',
      links: [
        { label: 'Token Usage', path: '/charge-budget?tab=token-usage' },
        { label: 'Cluster Costs', path: '/fleet-costs' },
      ],
    },
    {
      title: 'Cluster',
      description: 'Every deployment is a cluster, including a one-companion deployment. The cluster portal is the cluster-level entry point; each authorized companion opens into a separately scoped Garden.',
      links: [
        { label: 'Cluster overview', path: '/fleet', fleetLevel: true },
      ],
    },
  ];

  const flows: GuideFlow[] = [
    {
      title: 'Review a quarantined item',
      steps: [
        'Open Approvals and expand an awaiting-review item.',
        'Inspect why it was flagged, classifier findings, envelope history, and the sanitized representation before revealing raw content.',
        'Enter an audited reason, choose release raw, release sanitized, or discard, optionally teach the source list, then complete the two-step confirmation.',
      ],
      links: [{ label: 'Open Approvals', path: '/cognitive-security/approvals' }],
    },
    {
      title: 'Check tokens and costs',
      steps: [
        'Use Dashboard for a quick companion snapshot.',
        'Open Token Usage for model, provider, cache, time-window, and event detail.',
        'Use Cluster Costs when the question spans companions.',
      ],
      links: [
        { label: 'Token Usage', path: '/charge-budget?tab=token-usage' },
        { label: 'Cluster Costs', path: '/fleet-costs' },
      ],
    },
    {
      title: 'Save settings',
      steps: [
        'Make changes in the relevant Settings tab and use the floating Save Settings control.',
        'Treat a staged raw JSON edit as a separate owner-file change: it can block the unified save or cause that owner file to be skipped until the raw edit is saved or discarded.',
        'Wait for the save confirmation; the control records the most recent confirmed save for this companion.',
      ],
      links: [{ label: 'Open Settings', path: '/settings' }],
    },
    {
      title: 'Switch companions',
      steps: [
        'Use the companion selector in the Garden sidebar for a direct switch, or return to Cluster overview.',
        'A switch clears the previous companion browser scope before loading the selected companion Garden.',
      ],
      links: [{ label: 'Cluster overview', path: '/fleet', fleetLevel: true }],
    },
    {
      title: 'Recover a session',
      steps: [
        'Open Session Recovery for a poisoned, over-compressed, or otherwise bad live session route.',
        'Start a fresh logical session for the source channel. Old L0 history is retained for audit and search; row-level redaction belongs in CogSec Remediation.',
      ],
      links: [{ label: 'Session Recovery', path: '/session-recovery' }],
    },
  ];

  const repositoryDocs = [
    {
      label: 'docs/operations.md',
      href: 'https://github.com/CGIC-AI/psfn-framework/blob/main/docs/operations.md',
      description: 'deployment, recovery, health checks, and operational procedures',
    },
    {
      label: 'docs/multi-companion.md',
      href: 'https://github.com/CGIC-AI/psfn-framework/blob/main/docs/multi-companion.md',
      description: 'cluster topology, authorization, and per-companion Garden boundaries',
    },
    {
      label: 'docs/cognitive-security.md',
      href: 'https://github.com/CGIC-AI/psfn-framework/blob/main/docs/cognitive-security.md',
      description: 'intake screening, quarantine, source lists, and remediation',
    },
    {
      label: 'docs/architecture.md',
      href: 'https://github.com/CGIC-AI/psfn-framework/blob/main/docs/architecture.md',
      description: 'runtime ownership and subsystem map',
    },
    {
      label: 'docs/setup.md',
      href: 'https://github.com/CGIC-AI/psfn-framework/blob/main/docs/setup.md',
      description: 'bootstrap and local bring-up',
    },
  ];

  function guideHref(link: GuideLink): string {
    return link.fleetLevel ? link.path : scopeGardenPath(link.path);
  }
</script>

<svelte:head>
  <title>Operator Guide · Garden</title>
</svelte:head>

<div class="space-y-8">
  <header>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-gold-700">Garden map</p>
    <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Operator Guide</h1>
    <p class="mt-2 max-w-3xl text-sm leading-relaxed text-shadow-600">
      A concise map for day-to-day operation. Use the linked repository docs for procedures and architecture detail.
    </p>
  </header>

  <section class="space-y-4" aria-labelledby="locations-title">
    <div>
      <h2 id="locations-title" class="font-serif text-xl font-semibold text-shadow-900">Where things live</h2>
      <p class="mt-1 text-sm text-shadow-600">Links stay inside the active companion Garden unless marked cluster-level.</p>
    </div>
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each locations as location (location.title)}
        <article class="card-garden p-5">
          <h3 class="font-serif text-lg font-semibold text-shadow-900">{location.title}</h3>
          <p class="mt-2 text-sm leading-relaxed text-shadow-700">{location.description}</p>
          <div class="mt-4 flex flex-wrap gap-2">
            {#each location.links as link (link.label)}
              <a
                href={guideHref(link)}
                class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm font-medium text-gold-700 transition-colors hover:border-gold-400 hover:bg-gold-50"
              >
                {link.label}
              </a>
            {/each}
          </div>
        </article>
      {/each}
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="flows-title">
    <div>
      <h2 id="flows-title" class="font-serif text-xl font-semibold text-shadow-900">Common flows</h2>
      <p class="mt-1 text-sm text-shadow-600">Short paths through the operator tasks that recur most often.</p>
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      {#each flows as flow (flow.title)}
        <article class="card-garden p-5">
          <h3 class="font-serif text-lg font-semibold text-shadow-900">{flow.title}</h3>
          <ol class="mt-3 space-y-2 pl-5 text-sm leading-relaxed text-shadow-700 list-decimal marker:font-semibold marker:text-gold-700">
            {#each flow.steps as step (step)}
              <li class="pl-1">{step}</li>
            {/each}
          </ol>
          <div class="mt-4 flex flex-wrap gap-3">
            {#each flow.links as link (link.label)}
              <a href={guideHref(link)} class="text-sm font-medium text-gold-700 underline-offset-2 hover:underline">
                {link.label} &rarr;
              </a>
            {/each}
          </div>
        </article>
      {/each}
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="health-title">
    <div>
      <h2 id="health-title" class="font-serif text-xl font-semibold text-shadow-900">What health messages mean</h2>
      <p class="mt-1 text-sm text-shadow-600">Health is dimension-specific. An unknown or degraded dimension is not evidence that every companion surface is down.</p>
    </div>
    <div class="grid gap-4 lg:grid-cols-3">
      <article class="card-garden p-5 lg:col-span-2">
        <h3 class="font-serif text-lg font-semibold text-shadow-900">Cluster companion status</h3>
        <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
            <dt class="font-semibold text-shadow-800">Agent</dt>
            <dd class="mt-1 leading-relaxed text-shadow-600">Gateway-to-agent RPC registration: up when connected, down when absent, unknown while registering.</dd>
          </div>
          <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
            <dt class="font-semibold text-shadow-800">Admin</dt>
            <dd class="mt-1 leading-relaxed text-shadow-600">Reachability of that companion's Garden admin transport. Only an up Admin dimension enables Open Garden.</dd>
          </div>
          <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
            <dt class="font-semibold text-shadow-800">Channels</dt>
            <dd class="mt-1 leading-relaxed text-shadow-600">Routed channel connectivity: one confirmed connection is up; all confirmed disconnected is down; incomplete evidence is unknown.</dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-shadow-500">
          Unknown means there is no honest current signal. It should not be read as either healthy or failed.
        </p>
      </article>

      <article class="card-garden p-5">
        <h3 class="font-serif text-lg font-semibold text-shadow-900">Degraded subsystems</h3>
        <p class="mt-2 text-sm leading-relaxed text-shadow-700">
          If a degraded-subsystems banner appears, treat it as a partial-health warning rather than a whole-companion outage. Open Subsystem Health to identify the background lane, its last reason or error, and whether it is degraded, failed, stale, skipped, paused, or has not produced data since process start.
        </p>
        <a href={scopeGardenPath('/subsystem-health')} class="mt-3 inline-flex text-sm font-medium text-gold-700 underline-offset-2 hover:underline">
          Open Subsystem Health &rarr;
        </a>
      </article>

      <article class="card-garden p-5 lg:col-span-3">
        <h3 class="font-serif text-lg font-semibold text-shadow-900">Skills-root degradation</h3>
        <p class="mt-2 text-sm leading-relaxed text-shadow-700">
          A missing skills-root warning names configured, non-custom roots that do not exist on disk; those roots cannot contribute skills. “Requires gateway connection” instead means the runtime snapshot is unavailable—it does not prove the skill catalog is empty.
        </p>
        <a href={scopeGardenPath('/skills')} class="mt-3 inline-flex text-sm font-medium text-gold-700 underline-offset-2 hover:underline">
          Open Skills &rarr;
        </a>
      </article>
    </div>
  </section>

  <section class="card-garden p-5" aria-labelledby="docs-title">
    <h2 id="docs-title" class="font-serif text-xl font-semibold text-shadow-900">Repository references</h2>
    <p class="mt-1 text-sm text-shadow-600">These are the maintained references; this page intentionally does not duplicate them.</p>
    <ul class="mt-4 grid gap-3 md:grid-cols-2">
      {#each repositoryDocs as doc (doc.label)}
        <li class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <a
            href={doc.href}
            target="_blank"
            rel="noreferrer"
            class="font-mono text-sm font-semibold text-gold-700 underline-offset-2 hover:underline"
          >
            {doc.label}
          </a>
          <p class="mt-1 text-sm text-shadow-600">{doc.description}</p>
        </li>
      {/each}
    </ul>
  </section>
</div>
