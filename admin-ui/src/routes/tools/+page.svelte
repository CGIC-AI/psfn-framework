<script lang="ts">
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';

  // ── Tool definitions ──
  interface ToolInfo {
    name: string;
    description: string;
    category: string;
  }

  type ToolCategory = 'core' | 'memory' | 'contact' | 'lifecycle' | 'git' | 'prompt' | 'heartbeat' | 'trust';

  const CATEGORY_BADGE: Record<string, string> = {
    core:      'bg-gold-100 text-gold-700',
    memory:    'bg-moss-100 text-moss-700',
    contact:   'bg-petal-100 text-petal-700',
    lifecycle: 'bg-wilt-100 text-wilt-700',
    git:       'bg-bark-200 text-shadow-800',
    prompt:    'bg-gold-50 text-gold-600',
    heartbeat: 'bg-moss-100 text-moss-700',
    trust:     'bg-gold-100 text-gold-700',
  };

  const CATEGORY_DOT: Record<string, string> = {
    core:      'bg-gold-400',
    memory:    'bg-moss-400',
    contact:   'bg-petal-400',
    lifecycle: 'bg-wilt-400',
    git:       'bg-shadow-600',
    prompt:    'bg-gold-400',
    heartbeat: 'bg-moss-400',
    trust:     'bg-gold-500',
  };

  const CORE_TOOLS: ToolInfo[] = [
    { name: 'think',               description: 'RLM+REPL sandbox for multi-step reasoning with code execution',  category: 'core' },
    { name: 'spawn_shard',         description: 'Launch ephemeral sub-agent for parallel work',                    category: 'core' },
    { name: 'memory_write',        description: 'Write a single memory directly to L2 store',                     category: 'memory' },
    { name: 'memory_import_batch', description: 'Import multiple memories in a single batch',                     category: 'memory' },
    { name: 'contact_lookup',      description: 'Look up a contact by name or Discord ID',                        category: 'contact' },
    { name: 'contact_list',        description: 'List all known contacts with trust levels',                      category: 'contact' },
    { name: 'self_restart',        description: 'Gracefully restart the agent process',                            category: 'lifecycle' },
    { name: 'self_rebuild',        description: 'Trigger a rebuild and restart cycle',                             category: 'lifecycle' },
    { name: 'load_tools',          description: 'Hot-swap active tool set to include extended tools',              category: 'core' },
  ];

  const EXTENDED_TOOLS: ToolInfo[] = [
    { name: 'git_status',              description: 'Show working tree status of the substrate repo',        category: 'git' },
    { name: 'git_diff',                description: 'Show file diffs in the working tree',                   category: 'git' },
    { name: 'git_branch',              description: 'Create or switch branches',                             category: 'git' },
    { name: 'git_commit',              description: 'Stage and commit changes with audit metadata',          category: 'git' },
    { name: 'git_patch',               description: 'Apply a patch to files in allowed paths',               category: 'git' },
    { name: 'git_pr',                  description: 'Create a pull request from current branch',             category: 'git' },
    { name: 'prompt_list',             description: 'List all prompt layers in the stack',                   category: 'prompt' },
    { name: 'prompt_get',              description: 'Get content of a specific prompt layer',                category: 'prompt' },
    { name: 'prompt_update',           description: 'Update a prompt layer (agent blocks base/operator)',    category: 'prompt' },
    { name: 'prompt_toggle',           description: 'Enable or disable a prompt layer',                      category: 'prompt' },
    { name: 'heartbeat_get_policy',    description: 'View heartbeat reflection templates and schedules',     category: 'heartbeat' },
    { name: 'heartbeat_update_policy', description: 'Modify reflection templates or intervals',              category: 'heartbeat' },
    { name: 'schedule_task',           description: 'Create one-shot scheduled tasks',                       category: 'heartbeat' },
    { name: 'contact_set_trust',       description: 'Change trust level for a contact',                      category: 'trust' },
    { name: 'contact_note',            description: 'Add or update notes on a contact',                      category: 'trust' },
  ];

  // ── Service health state ──
  interface ServiceStatus {
    name: string;
    description: string;
    status: 'healthy' | 'degraded' | 'unavailable' | 'loading';
    detail?: string;
  }

  let services = $state<ServiceStatus[]>([
    { name: 'Admin API',  description: 'Garden admin server',                              status: 'loading' },
    { name: 'LLM Proxy',  description: 'LiteLLM proxy for model routing',                  status: 'loading' },
    { name: 'Embeddings',  description: 'Ollama embedding service (snowflake-arctic-embed2)', status: 'loading' },
  ]);

  const STATUS_COLOR: Record<ServiceStatus['status'], string> = {
    healthy:     'bg-moss-500',
    degraded:    'bg-gold-500',
    unavailable: 'bg-wilt-500',
    loading:     'bg-bark-400 animate-pulse',
  };

  const STATUS_LABEL: Record<ServiceStatus['status'], string> = {
    healthy:     'Healthy',
    degraded:    'Degraded',
    unavailable: 'Unavailable',
    loading:     'Checking...',
  };

  const STATUS_TEXT: Record<ServiceStatus['status'], string> = {
    healthy:     'text-moss-700',
    degraded:    'text-gold-700',
    unavailable: 'text-wilt-600',
    loading:     'text-shadow-700',
  };

  async function checkHealth() {
    // Check admin API health
    try {
      const res = await fetch('/health');
      if (res.ok) {
        const data = await res.json() as { status?: string; uptime?: number };
        const uptimeStr = data.uptime ? formatUptime(data.uptime) : undefined;
        services[0] = {
          ...services[0],
          status: 'healthy',
          detail: uptimeStr ? `Uptime: ${uptimeStr}` : 'Responding',
        };
      } else {
        services[0] = { ...services[0], status: 'degraded', detail: `HTTP ${res.status}` };
      }
    } catch {
      services[0] = { ...services[0], status: 'unavailable', detail: 'Connection failed' };
    }

    // Check LLM proxy by attempting models list
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json() as unknown[];
        services[1] = {
          ...services[1],
          status: 'healthy',
          detail: `${Array.isArray(data) ? data.length : 0} models discovered`,
        };
      } else {
        services[1] = { ...services[1], status: 'degraded', detail: `HTTP ${res.status}` };
      }
    } catch {
      services[1] = { ...services[1], status: 'unavailable', detail: 'Not reachable' };
    }

    // Embeddings: check via dashboard stats (indirect indicator)
    try {
      const dashRes = await apiGet<{ stats: { memoryTotal: number } }>('/api/admin/dashboard');
      if (dashRes.stats.memoryTotal >= 0) {
        services[2] = {
          ...services[2],
          status: 'healthy',
          detail: `${dashRes.stats.memoryTotal} memories indexed`,
        };
      }
    } catch {
      services[2] = { ...services[2], status: 'unavailable', detail: 'Dashboard unreachable' };
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // ── Grouped extended tools ──
  const gitTools = EXTENDED_TOOLS.filter(t => t.category === 'git');
  const promptTools = EXTENDED_TOOLS.filter(t => t.category === 'prompt');
  const heartbeatTools = EXTENDED_TOOLS.filter(t => t.category === 'heartbeat');
  const trustTools = EXTENDED_TOOLS.filter(t => t.category === 'trust');

  let refreshing = $state(false);

  async function refreshHealth() {
    refreshing = true;
    services = services.map(s => ({ ...s, status: 'loading' as const, detail: undefined }));
    await checkHealth();
    refreshing = false;
  }

  onMount(() => {
    checkHealth();
  });
</script>

<div class="space-y-8">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900">The Shed</h1>
    <p class="text-sm text-shadow-700 mt-1">Tools and services available to the substrate agent</p>
  </div>

  <!-- Tool loading info -->
  <div class="card-garden p-4">
    <div class="flex items-start gap-3">
      <svg class="w-5 h-5 text-gold-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.663 17h4.674M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
      <div class="text-sm text-shadow-800">
        <p><strong class="text-shadow-900">Lazy loading:</strong> Only <strong>{CORE_TOOLS.length} core tools</strong> are active by default each turn. The agent calls <code class="font-mono text-xs bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">load_tools</code> to activate the <strong>{EXTENDED_TOOLS.length} extended tools</strong> when needed. Tools reset to core-only at the start of each turn.</p>
      </div>
    </div>
  </div>

  <!-- Core Tools -->
  <div>
    <div class="flex items-baseline gap-3 mb-4">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Core Tools</h2>
      <span class="text-sm font-sans text-shadow-600">{CORE_TOOLS.length} tools -- always available</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each CORE_TOOLS as tool}
        <div class="card-garden p-4">
          <div class="flex items-center gap-2.5 mb-2">
            <span class="inline-block w-2 h-2 rounded-full {CATEGORY_DOT[tool.category] || 'bg-bark-400'}"></span>
            <code class="text-sm font-mono font-medium text-shadow-900">{tool.name}</code>
            <span class="inline-block px-1.5 py-0.5 rounded text-sm font-medium {CATEGORY_BADGE[tool.category] || 'bg-bark-200 text-shadow-600'}">{tool.category}</span>
          </div>
          <p class="text-sm text-shadow-700 leading-relaxed pl-[18px]">{tool.description}</p>
        </div>
      {/each}
    </div>
  </div>

  <!-- Extended Tools -->
  <div>
    <div class="flex items-baseline gap-3 mb-4">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Extended Tools</h2>
      <span class="text-sm font-sans text-shadow-600">{EXTENDED_TOOLS.length} tools -- loaded on demand via <code class="font-mono text-gold-600">load_tools</code></span>
    </div>

    <!-- Git tools -->
    <div class="mb-5">
      <h3 class="text-sm font-semibold text-shadow-800 mb-2 flex items-center gap-2">
        <span class="inline-block w-2 h-2 rounded-full {CATEGORY_DOT.git}"></span>
        Git Self-Modification
        <span class="text-sm font-normal text-shadow-600">({gitTools.length})</span>
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each gitTools as tool}
          <div class="card-garden p-4">
            <div class="flex items-center gap-2.5 mb-2">
              <code class="text-sm font-mono font-medium text-shadow-900">{tool.name}</code>
              <span class="inline-block px-1.5 py-0.5 rounded text-sm font-medium {CATEGORY_BADGE.git}">git</span>
            </div>
            <p class="text-sm text-shadow-700 leading-relaxed">{tool.description}</p>
          </div>
        {/each}
      </div>
    </div>

    <!-- Prompt tools -->
    <div class="mb-5">
      <h3 class="text-sm font-semibold text-shadow-800 mb-2 flex items-center gap-2">
        <span class="inline-block w-2 h-2 rounded-full {CATEGORY_DOT.prompt}"></span>
        Prompt Stack
        <span class="text-sm font-normal text-shadow-600">({promptTools.length})</span>
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each promptTools as tool}
          <div class="card-garden p-4">
            <div class="flex items-center gap-2.5 mb-2">
              <code class="text-sm font-mono font-medium text-shadow-900">{tool.name}</code>
              <span class="inline-block px-1.5 py-0.5 rounded text-sm font-medium {CATEGORY_BADGE.prompt}">prompt</span>
            </div>
            <p class="text-sm text-shadow-700 leading-relaxed">{tool.description}</p>
          </div>
        {/each}
      </div>
    </div>

    <!-- Heartbeat / Scheduler tools -->
    <div class="mb-5">
      <h3 class="text-sm font-semibold text-shadow-800 mb-2 flex items-center gap-2">
        <span class="inline-block w-2 h-2 rounded-full {CATEGORY_DOT.heartbeat}"></span>
        Heartbeat & Scheduler
        <span class="text-sm font-normal text-shadow-600">({heartbeatTools.length})</span>
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each heartbeatTools as tool}
          <div class="card-garden p-4">
            <div class="flex items-center gap-2.5 mb-2">
              <code class="text-sm font-mono font-medium text-shadow-900">{tool.name}</code>
              <span class="inline-block px-1.5 py-0.5 rounded text-sm font-medium {CATEGORY_BADGE.heartbeat}">scheduler</span>
            </div>
            <p class="text-sm text-shadow-700 leading-relaxed">{tool.description}</p>
          </div>
        {/each}
      </div>
    </div>

    <!-- Trust tools -->
    <div class="mb-5">
      <h3 class="text-sm font-semibold text-shadow-800 mb-2 flex items-center gap-2">
        <span class="inline-block w-2 h-2 rounded-full {CATEGORY_DOT.trust}"></span>
        Trust & Contacts
        <span class="text-sm font-normal text-shadow-600">({trustTools.length})</span>
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each trustTools as tool}
          <div class="card-garden p-4">
            <div class="flex items-center gap-2.5 mb-2">
              <code class="text-sm font-mono font-medium text-shadow-900">{tool.name}</code>
              <span class="inline-block px-1.5 py-0.5 rounded text-sm font-medium {CATEGORY_BADGE.trust}">trust</span>
            </div>
            <p class="text-sm text-shadow-700 leading-relaxed">{tool.description}</p>
          </div>
        {/each}
      </div>
    </div>
  </div>

  <!-- Service Health -->
  <div>
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-baseline gap-3">
        <h2 class="text-lg font-serif font-semibold text-shadow-900">Service Health</h2>
        <span class="text-sm font-sans text-shadow-600">{services.length} services</span>
      </div>
      <button
        onclick={refreshHealth}
        disabled={refreshing}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
               text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {refreshing ? 'Checking...' : 'Refresh'}
      </button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      {#each services as service}
        <div class="card-garden p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-shadow-900">{service.name}</h3>
            <span class="flex items-center gap-1.5">
              <span class="inline-block w-2.5 h-2.5 rounded-full {STATUS_COLOR[service.status]}"></span>
              <span class="text-sm font-medium {STATUS_TEXT[service.status]}">{STATUS_LABEL[service.status]}</span>
            </span>
          </div>
          <p class="text-sm text-shadow-700 mb-2">{service.description}</p>
          {#if service.detail}
            <p class="text-sm font-mono text-shadow-800 bg-bark-100 rounded px-2 py-1">{service.detail}</p>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
