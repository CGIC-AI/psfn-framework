<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getSkillsData,
    createSkill,
    updateSkill,
    toggleSkill,
    deleteSkill,
  } from '$lib/api/endpoints/skills';
  import type {
    SkillSnapshot,
    SkillEntry,
    SkillSkipRecord,
    ManagedSkill,
  } from '$lib/types';
  import { pushToast } from '$lib/stores/toast.svelte';

  // ── State ──
  let snapshot = $state<SkillSnapshot | null>(null);
  let managed = $state<ManagedSkill[]>([]);
  let disabledSkills = $state<string[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);

  // UI state
  let expandedSkills = $state<Set<string>>(new Set());
  let editingSkill = $state<string | null>(null);
  let editContent = $state('');
  let editDescription = $state('');
  let savingSkill = $state<string | null>(null);
  let togglingSkill = $state<string | null>(null);
  let deletingSkill = $state<string | null>(null);
  let actionError = $state('');

  // Create form state
  let showCreateForm = $state(false);
  let newName = $state('');
  let newCategory = $state('custom');
  let newDescription = $state('');
  let newContent = $state('');
  let creating = $state(false);

  // Filter state
  let filterSource = $state<string>('all');
  let filterStatus = $state<string>('all');

  // Native behavior skills (file-based skills that represent native agent behavior, not managed skills)
  const NATIVE_BEHAVIOR_SKILLS = ['conversation'];

  function isNativeBehavior(name: string): boolean {
    return NATIVE_BEHAVIOR_SKILLS.includes(name.toLowerCase());
  }

  function isManaged(name: string): boolean {
    return managed.some(m => m.name.toLowerCase() === name.toLowerCase());
  }

  function isDisabled(name: string): boolean {
    return disabledSkills.includes(name);
  }

  function getManagedRecord(name: string): ManagedSkill | undefined {
    return managed.find(m => m.name.toLowerCase() === name.toLowerCase());
  }

  function toggleExpand(id: string) {
    const next = new Set(expandedSkills);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedSkills = next;
  }

  function startEdit(skill: SkillEntry) {
    editingSkill = skill.id;
    editContent = skill.content;
    editDescription = skill.description;
    actionError = '';
  }

  function cancelEdit() {
    editingSkill = null;
    editContent = '';
    editDescription = '';
    actionError = '';
  }

  async function saveEdit(skill: SkillEntry) {
    savingSkill = skill.id;
    actionError = '';
    try {
      await updateSkill({
        name: skill.name,
        content: editContent,
        description: editDescription || undefined,
      });
      editingSkill = null;
      pushToast(`Saved "${skill.name}"`, 'success');
      await loadData();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to save skill';
      pushToast(actionError, 'error');
    } finally {
      savingSkill = null;
    }
  }

  async function handleToggle(name: string) {
    togglingSkill = name;
    actionError = '';
    try {
      const result = await toggleSkill(name);
      if (result.enabled) {
        disabledSkills = disabledSkills.filter(s => s !== name);
      } else {
        disabledSkills = [...disabledSkills, name];
      }
      pushToast(`Skill "${name}" ${result.enabled ? 'enabled' : 'disabled'}`, 'success');
      await loadData();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to toggle skill';
      pushToast(actionError, 'error');
    } finally {
      togglingSkill = null;
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete managed skill "${name}"? This cannot be undone.`)) return;
    deletingSkill = name;
    actionError = '';
    try {
      await deleteSkill(name);
      pushToast(`Deleted "${name}"`, 'success');
      await loadData();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to delete skill';
      pushToast(actionError, 'error');
    } finally {
      deletingSkill = null;
    }
  }

  async function handleCreate() {
    creating = true;
    actionError = '';
    const createdName = newName.trim();
    try {
      await createSkill({
        name: createdName,
        category: newCategory.trim() || 'custom',
        content: newContent.trim(),
        description: newDescription.trim() || undefined,
      });
      newName = '';
      newCategory = 'custom';
      newDescription = '';
      newContent = '';
      showCreateForm = false;
      pushToast(`Created "${createdName}"`, 'success');
      await loadData();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to create skill';
      pushToast(actionError, 'error');
    } finally {
      creating = false;
    }
  }

  // Build a unified list of all skills (included + skipped/filtered)
  interface UnifiedSkill {
    id: string;
    name: string;
    description: string;
    content: string;
    source: string;
    relativePath: string;
    always: boolean;
    category?: string;
    included: boolean;
    disabled: boolean;
    native: boolean;
    managed: boolean;
    skipReason?: string;
    skipDetails?: string[];
    size: number;
  }

  let allSkills = $derived.by((): UnifiedSkill[] => {
    if (!snapshot) return [];

    const skills: UnifiedSkill[] = [];
    const seenNames = new Set<string>();

    // Included skills
    for (const skill of snapshot.includedSkills) {
      const name = skill.name;
      if (isNativeBehavior(name)) continue; // Filter out native behavior skills
      seenNames.add(name.toLowerCase());
      skills.push({
        id: skill.id,
        name,
        description: skill.description,
        content: skill.content,
        source: skill.source,
        relativePath: skill.relativePath,
        always: skill.always,
        category: skill.category,
        included: true,
        disabled: isDisabled(name),
        native: false,
        managed: isManaged(name),
        size: skill.size || skill.content.length,
      });
    }

    // Skipped skills (add ones not already seen, excluding native behavior)
    for (const skipped of snapshot.skipped) {
      if (seenNames.has(skipped.name.toLowerCase())) continue;
      if (isNativeBehavior(skipped.name)) continue;
      seenNames.add(skipped.name.toLowerCase());
      skills.push({
        id: `skipped-${skipped.name}`,
        name: skipped.name,
        description: '',
        content: '',
        source: skipped.source,
        relativePath: skipped.relativePath,
        always: false,
        included: false,
        disabled: isDisabled(skipped.name),
        native: false,
        managed: isManaged(skipped.name),
        skipReason: skipped.reason,
        skipDetails: skipped.details,
        size: 0,
      });
    }

    return skills;
  });

  let filteredSkills = $derived.by((): UnifiedSkill[] => {
    let result = allSkills;
    if (filterSource !== 'all') {
      result = result.filter(s => s.source === filterSource);
    }
    if (filterStatus === 'enabled') {
      result = result.filter(s => !s.disabled && s.included);
    } else if (filterStatus === 'disabled') {
      result = result.filter(s => s.disabled || !s.included);
    }
    return result;
  });

  let uniqueSources = $derived.by((): string[] => {
    const sources = new Set(allSkills.map(s => s.source));
    return [...sources].sort();
  });

  function formatRequires(entry: SkillEntry): string {
    const parts: string[] = [];
    if (entry.requires.binaries.length > 0) parts.push(`bin:${entry.requires.binaries.join(',')}`);
    if (entry.requires.env.length > 0) parts.push(`env:${entry.requires.env.join(',')}`);
    if (entry.requires.config.length > 0) parts.push(`cfg:${entry.requires.config.join(',')}`);
    return parts.length > 0 ? parts.join(' | ') : 'none';
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;

    try {
      const data = await getSkillsData();
      snapshot = data.snapshot;
      managed = data.managed ?? [];
      disabledSkills = data.disabledSkills ?? [];
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load skills data';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadData();
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Crafts</h1>
      <p class="text-sm text-shadow-600 mt-1">Skills discovered, loaded, and injected into runtime context</p>
    </div>
    <div class="flex gap-2">
      {#if snapshot}
        <button
          onclick={() => { showCreateForm = !showCreateForm; actionError = ''; }}
          class="text-sm px-3 py-1.5 rounded-lg border border-gold-400
                 text-gold-700 hover:bg-gold-50
                 transition-colors font-medium"
        >
          {showCreateForm ? 'Cancel' : '+ New Skill'}
        </button>
      {/if}
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
               text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  <!-- Action Error Banner -->
  {#if actionError}
    <div class="card-garden p-4 border-l-4 border-l-wilt-400 flex items-start justify-between">
      <p class="text-sm text-wilt-700">{actionError}</p>
      <button data-esc-close onclick={() => actionError = ''} class="text-shadow-400 hover:text-shadow-600 ml-4 shrink-0">&times;</button>
    </div>
  {/if}

  {#if loading}
    <div class="space-y-3">
      <div class="card-garden p-5 animate-pulse space-y-3">
        <div class="h-5 rounded bg-bark-200 w-1/3"></div>
        <div class="h-4 rounded bg-bark-200 w-1/2"></div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
          {#each Array(4) as _}
            <div class="h-14 rounded bg-bark-200"></div>
          {/each}
        </div>
      </div>
      {#each Array(3) as _}
        <div class="card-garden p-5 animate-pulse space-y-2">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-4/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
        </div>
      {/each}
      <p class="text-sm text-shadow-600 px-1">Loading skills snapshot...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing || !snapshot}
    <div class="card-garden p-6">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-bark-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="text-sm text-shadow-800">
            Requires gateway connection
          </p>
          <p class="text-sm text-shadow-600 mt-2">
            The skills runtime snapshot is available when the agent is running with an active gateway.
            Skills config can be edited on the <a href="/garden/settings" class="text-gold-600 hover:text-gold-700 underline">Settings</a> page via the skills config editor.
          </p>
        </div>
      </div>
    </div>

    <!-- What the skills system does -->
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">About Skills</h2>
      <div class="space-y-3 text-sm text-shadow-700">
        <p>The skills system discovers, evaluates, and injects skill definitions into the agent's runtime context as XML prompt content.</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Discovery</p>
            <p>Scans configured directories for skill files, evaluating eligibility based on requirements (binaries, env vars, config).</p>
          </div>
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Budget</p>
            <p>Skills are limited by <code class="font-mono text-sm bg-bark-100 px-1 rounded text-gold-700">maxSkills</code> and <code class="font-mono text-sm bg-bark-100 px-1 rounded text-gold-700">maxChars</code> to control context consumption.</p>
          </div>
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Injection</p>
            <p>Eligible skills are formatted as XML and injected into the agent's system prompt each turn.</p>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <!-- Runtime Snapshot Summary -->
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-4">Runtime Snapshot</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Generated At</p>
          <p class="text-sm font-mono text-shadow-800">{snapshot.generatedAt}</p>
        </div>
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Runtime Enabled</p>
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {snapshot.configEnabled ? 'bg-moss-100 text-moss-700' : 'bg-wilt-100 text-wilt-600'}">
            {snapshot.configEnabled ? 'yes' : 'no'}
          </span>
        </div>
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Prompt XML</p>
          <p class="text-sm font-mono text-shadow-800">{snapshot.promptXml.length.toLocaleString()} chars</p>
        </div>
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Budget</p>
          <p class="text-sm font-mono text-shadow-800">{snapshot.budget.maxSkills} skills / {snapshot.budget.maxChars.toLocaleString()} chars</p>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-bark-100">
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-shadow-900">{snapshot.scannedFiles}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Discovered</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-gold-600">{snapshot.loadedSkills}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Loaded</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-moss-600">{snapshot.includedSkills.length}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Injected</p>
        </div>
      </div>
    </div>

    <!-- Create Skill Form -->
    {#if showCreateForm}
      <div class="card-garden p-5 border-l-4 border-l-gold-400">
        <h2 class="text-base font-serif font-semibold text-shadow-900 mb-4">Create New Skill</h2>
        <div class="space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label for="new-skill-name" class="block text-sm font-medium text-shadow-700 mb-1">Name</label>
              <input
                id="new-skill-name"
                type="text"
                bind:value={newName}
                placeholder="my-skill"
                class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg
                       bg-white text-shadow-800 placeholder-shadow-400
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              />
            </div>
            <div>
              <label for="new-skill-category" class="block text-sm font-medium text-shadow-700 mb-1">Category</label>
              <input
                id="new-skill-category"
                type="text"
                bind:value={newCategory}
                placeholder="custom"
                class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg
                       bg-white text-shadow-800 placeholder-shadow-400
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              />
            </div>
            <div>
              <label for="new-skill-description" class="block text-sm font-medium text-shadow-700 mb-1">Description</label>
              <input
                id="new-skill-description"
                type="text"
                bind:value={newDescription}
                placeholder="Optional (derived from content if omitted)"
                class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg
                       bg-white text-shadow-800 placeholder-shadow-400
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              />
            </div>
          </div>
          <div>
            <label for="new-skill-content" class="block text-sm font-medium text-shadow-700 mb-1">Content</label>
            <textarea
              id="new-skill-content"
              bind:value={newContent}
              rows="8"
              placeholder="# My Skill&#10;&#10;Skill prompt content in markdown..."
              class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg font-mono
                     bg-white text-shadow-800 placeholder-shadow-400 resize-y
                     focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
            ></textarea>
          </div>
          <div class="flex gap-2 justify-end">
            <button
              onclick={() => { showCreateForm = false; actionError = ''; }}
              data-esc-close
              class="px-4 py-2 text-sm rounded-lg border border-bark-300
                     text-shadow-600 hover:bg-bark-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onclick={handleCreate}
              disabled={creating || !newName.trim() || !newContent.trim()}
              class="px-4 py-2 text-sm rounded-lg font-medium
                     bg-gold-500 text-white hover:bg-gold-600
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating...' : 'Create Skill'}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-center">
      <label for="filter-source" class="text-sm text-shadow-600">Source:</label>
      <select
        id="filter-source"
        bind:value={filterSource}
        class="text-sm px-2 py-1 border border-bark-300 rounded-lg bg-white text-shadow-800
               focus:outline-none focus:ring-2 focus:ring-gold-300"
      >
        <option value="all">All</option>
        {#each uniqueSources as source}
          <option value={source}>{source}</option>
        {/each}
      </select>

      <label for="filter-status" class="text-sm text-shadow-600 ml-2">Status:</label>
      <select
        id="filter-status"
        bind:value={filterStatus}
        class="text-sm px-2 py-1 border border-bark-300 rounded-lg bg-white text-shadow-800
               focus:outline-none focus:ring-2 focus:ring-gold-300"
      >
        <option value="all">All</option>
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled / Filtered</option>
      </select>

      <span class="text-sm text-shadow-500 ml-auto">
        {filteredSkills.length} skill{filteredSkills.length === 1 ? '' : 's'}
      </span>
    </div>

    <!-- Skill Cards -->
    {#if filteredSkills.length === 0}
      <div class="card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">No skills match the current filters.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each filteredSkills as skill (skill.id)}
          {@const expanded = expandedSkills.has(skill.id)}
          {@const isEditing = editingSkill === skill.id}
          {@const isSaving = savingSkill === skill.id}
          {@const isToggling = togglingSkill === skill.name}
          {@const isDeleting = deletingSkill === skill.name}
          <div class="card-garden overflow-hidden {skill.disabled ? 'opacity-60' : ''}">
            <!-- Card Header -->
            <div class="px-5 py-4 flex items-start gap-3">
              <!-- Expand/Collapse Toggle -->
              <button
                onclick={() => toggleExpand(skill.id)}
                class="mt-0.5 shrink-0 text-shadow-400 hover:text-shadow-700 transition-colors"
                title={expanded ? 'Collapse' : 'Expand'}
              >
                <svg class="w-4 h-4 transition-transform {expanded ? 'rotate-90' : ''}" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
                </svg>
              </button>

              <!-- Skill Info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3 class="text-base font-semibold text-shadow-900">{skill.name}</h3>

                  <!-- Status Badge -->
                  {#if skill.included && !skill.disabled}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-moss-100 text-moss-700">
                      active
                    </span>
                  {:else if skill.disabled}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-wilt-100 text-wilt-600">
                      disabled
                    </span>
                  {:else}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-200 text-shadow-600">
                      filtered
                    </span>
                  {/if}

                  <!-- Source Badge -->
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-600">
                    {skill.source}
                  </span>

                  <!-- Managed Badge -->
                  {#if skill.managed}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">
                      managed
                    </span>
                  {/if}

                  {#if skill.always}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-200 text-shadow-600">
                      always
                    </span>
                  {/if}
                </div>

                {#if skill.description}
                  <p class="text-sm text-shadow-600 mt-1">{skill.description}</p>
                {/if}

                {#if skill.skipReason}
                  <p class="text-sm text-wilt-600 mt-1">Skipped: {skill.skipReason}</p>
                {/if}

                <div class="flex items-center gap-4 mt-1 text-xs text-shadow-500">
                  <span>{skill.relativePath}</span>
                  {#if skill.size > 0}
                    <span>{skill.size.toLocaleString()} chars</span>
                  {/if}
                  {#if skill.category}
                    <span>cat: {skill.category}</span>
                  {/if}
                </div>
              </div>

              <!-- Action Buttons -->
              <div class="flex items-center gap-2 shrink-0">
                <!-- Toggle Enable/Disable -->
                <button
                  onclick={() => handleToggle(skill.name)}
                  disabled={isToggling}
                  class="text-sm px-3 py-1 rounded-lg border transition-colors
                         {skill.disabled
                           ? 'border-moss-300 text-moss-600 hover:bg-moss-50'
                           : 'border-bark-300 text-shadow-600 hover:bg-bark-100'}
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  title={skill.disabled ? 'Enable this skill' : 'Disable this skill'}
                >
                  {isToggling ? '...' : skill.disabled ? 'Enable' : 'Disable'}
                </button>

                <!-- Edit (only for managed skills) -->
                {#if skill.managed}
                  <button
                    onclick={() => {
                      const entry = snapshot?.includedSkills.find(s => s.name === skill.name);
                      if (entry) startEdit(entry);
                      else {
                        // For skipped managed skills, use the managed record
                        const rec = getManagedRecord(skill.name);
                        if (rec) {
                          editingSkill = skill.id;
                          editContent = rec.content;
                          editDescription = rec.description;
                          actionError = '';
                        }
                      }
                      if (!expanded) toggleExpand(skill.id);
                    }}
                    class="text-sm px-3 py-1 rounded-lg border border-bark-300
                           text-shadow-600 hover:bg-bark-100 transition-colors"
                  >
                    Edit
                  </button>

                  <!-- Delete -->
                  <button
                    onclick={() => handleDelete(skill.name)}
                    disabled={isDeleting}
                    class="text-sm px-3 py-1 rounded-lg border border-wilt-300
                           text-wilt-600 hover:bg-wilt-50 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Delete this managed skill"
                  >
                    {isDeleting ? '...' : 'Delete'}
                  </button>
                {/if}
              </div>
            </div>

            <!-- Expanded Content -->
            {#if expanded}
              <div class="border-t border-bark-100 px-5 py-4">
                {#if isEditing && skill.managed}
                  <!-- Edit Mode -->
                  <div class="space-y-3">
                    <div>
                      <label for="edit-desc-{skill.id}" class="block text-sm font-medium text-shadow-700 mb-1">Description</label>
                      <input
                        id="edit-desc-{skill.id}"
                        type="text"
                        bind:value={editDescription}
                        class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg
                               bg-white text-shadow-800
                               focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      />
                    </div>
                    <div>
                      <label for="edit-content-{skill.id}" class="block text-sm font-medium text-shadow-700 mb-1">Content</label>
                      <textarea
                        id="edit-content-{skill.id}"
                        bind:value={editContent}
                        rows="12"
                        class="w-full px-3 py-2 text-sm border border-bark-300 rounded-lg font-mono
                               bg-white text-shadow-800 resize-y
                               focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      ></textarea>
                    </div>
                    <div class="flex gap-2 justify-end">
                      <button
                        onclick={cancelEdit}
                        class="px-3 py-1.5 text-sm rounded-lg border border-bark-300
                               text-shadow-600 hover:bg-bark-100 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onclick={() => {
                          const entry = snapshot?.includedSkills.find(s => s.name === skill.name);
                          if (entry) saveEdit(entry);
                          else {
                            // Construct a minimal SkillEntry for the save call
                            saveEdit({ name: skill.name } as SkillEntry);
                          }
                        }}
                        disabled={isSaving || !editContent.trim()}
                        class="px-3 py-1.5 text-sm rounded-lg font-medium
                               bg-gold-500 text-white hover:bg-gold-600
                               disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isSaving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                {:else}
                  <!-- Read-only content view -->
                  <div>
                    <p class="text-xs text-shadow-500 uppercase tracking-wide mb-2">Prompt Content</p>
                    {#if skill.content}
                      <pre class="text-sm font-mono text-shadow-800 bg-bark-50 border border-bark-200 rounded-lg p-4 whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">{skill.content}</pre>
                    {:else}
                      <p class="text-sm text-shadow-500 italic">Content not available (skill was filtered before loading).</p>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Discovery Directories -->
    {#if snapshot.directories.length > 0}
      <div class="card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">Discovery Directories</h2>
        <ul class="space-y-1">
          {#each snapshot.directories as dir}
            <li class="text-sm text-shadow-800">
              <code class="font-mono bg-bark-100 px-1.5 py-0.5 rounded text-shadow-700">{dir.relativePath}</code>
              <span class="text-shadow-600 ml-1">({dir.source})</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</div>
