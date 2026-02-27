<script lang="ts">
  interface ToolInfo {
    name: string;
    description: string;
  }

  const CORE_TOOLS: ToolInfo[] = [
    { name: 'think',               description: 'RLM+REPL sandbox for multi-step reasoning with code execution' },
    { name: 'spawn_shard',         description: 'Launch ephemeral sub-agent for parallel work' },
    { name: 'memory_write',        description: 'Write a single memory directly to L2 store' },
    { name: 'memory_import_batch', description: 'Import multiple memories in a single batch' },
    { name: 'contact_lookup',      description: 'Look up a contact by name or Discord ID' },
    { name: 'contact_list',        description: 'List all known contacts with trust levels' },
    { name: 'self_restart',        description: 'Gracefully restart the agent process' },
    { name: 'self_rebuild',        description: 'Trigger a rebuild and restart cycle' },
    { name: 'load_tools',          description: 'Hot-swap active tool set to include extended tools' },
  ];

  const EXTENDED_TOOLS: ToolInfo[] = [
    { name: 'git_status',              description: 'Show working tree status of the substrate repo' },
    { name: 'git_diff',                description: 'Show file diffs in the working tree' },
    { name: 'git_branch',              description: 'Create or switch branches' },
    { name: 'git_commit',              description: 'Stage and commit changes with audit metadata' },
    { name: 'git_patch',               description: 'Apply a patch to files in allowed paths' },
    { name: 'git_pr',                  description: 'Create a pull request from current branch' },
    { name: 'prompt_list',             description: 'List all prompt layers in the stack' },
    { name: 'prompt_get',              description: 'Get content of a specific prompt layer' },
    { name: 'prompt_update',           description: 'Update a prompt layer (agent blocks base/operator)' },
    { name: 'prompt_toggle',           description: 'Enable or disable a prompt layer' },
    { name: 'heartbeat_get_policy',    description: 'View heartbeat reflection templates and schedules' },
    { name: 'heartbeat_update_policy', description: 'Modify reflection templates or intervals' },
    { name: 'schedule_task',           description: 'Create one-shot scheduled tasks' },
    { name: 'contact_set_trust',       description: 'Change trust level for a contact' },
    { name: 'contact_note',            description: 'Add or update notes on a contact' },
  ];
</script>

<div class="space-y-6">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Shed</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Tools and services available to the substrate agent</p>
  </div>

  <!-- Tool loading info -->
  <div class="card-garden p-4">
    <div class="flex items-start gap-3">
      <svg class="w-5 h-5 text-gold-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2C12 2 5 10 5 15a7 7 0 0014 0c0-5-7-13-7-13z" />
      </svg>
      <div class="text-sm text-shadow-600 dark:text-bark-400">
        <p><strong class="text-shadow-800 dark:text-bark-200">Lazy loading:</strong> Only core tools are active by default each turn. The agent calls <code class="font-mono text-xs bg-bark-100 dark:bg-shadow-800 px-1 py-0.5 rounded">load_tools</code> to activate extended tools when needed.</p>
      </div>
    </div>
  </div>

  <!-- Core Tools -->
  <div>
    <h2 class="text-lg font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">
      Core Tools
      <span class="text-xs font-sans font-normal text-shadow-400 dark:text-bark-500 ml-2">{CORE_TOOLS.length} tools &mdash; always available</span>
    </h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each CORE_TOOLS as tool}
        <div class="card-garden p-4">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-moss-400"></span>
            <code class="text-sm font-mono font-medium text-shadow-800 dark:text-bark-200">{tool.name}</code>
          </div>
          <p class="text-xs text-shadow-500 dark:text-bark-400 leading-relaxed">{tool.description}</p>
        </div>
      {/each}
    </div>
  </div>

  <!-- Extended Tools -->
  <div>
    <h2 class="text-lg font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">
      Extended Tools
      <span class="text-xs font-sans font-normal text-shadow-400 dark:text-bark-500 ml-2">{EXTENDED_TOOLS.length} tools &mdash; loaded on demand</span>
    </h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each EXTENDED_TOOLS as tool}
        <div class="card-garden p-4">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-gold-400"></span>
            <code class="text-sm font-mono font-medium text-shadow-800 dark:text-bark-200">{tool.name}</code>
          </div>
          <p class="text-xs text-shadow-500 dark:text-bark-400 leading-relaxed">{tool.description}</p>
        </div>
      {/each}
    </div>
  </div>

  <!-- Service Health placeholder -->
  <div>
    <h2 class="text-lg font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Service Health</h2>
    <div class="card-garden p-8 text-center">
      <svg class="w-12 h-12 mx-auto text-bark-300 dark:text-shadow-700 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-6.36l-1.42 1.42M8.06 15.94l-1.42 1.42m12.72 0l-1.42-1.42M8.06 8.06L6.64 6.64M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
      <p class="font-serif text-shadow-500 dark:text-bark-400">Health checks coming soon</p>
      <p class="text-xs text-shadow-400 dark:text-bark-500 mt-1">LLM, embeddings, gateway, scheduler, and Discord connectivity status</p>
    </div>
  </div>
</div>
