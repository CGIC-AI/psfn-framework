<script lang="ts">
  import { onMount } from 'svelte';
  import { getSkillsData } from '$lib/api/endpoints/skills';
  import type { SkillSnapshot, SkillEntry, SkillSkipRecord } from '$lib/types';

  // ── State ──
  let snapshot = $state<SkillSnapshot | null>(null);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);

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

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading skills snapshot...</p>
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
  {:else if snapshot}
    <!-- Runtime Snapshot -->
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-4">Runtime Snapshot</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Generated At</p>
          <p class="text-sm font-mono text-shadow-800">{snapshot.generatedAt}</p>
        </div>
        <div>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-1">Signature</p>
          <p class="text-sm font-mono text-shadow-800 truncate" title={snapshot.signature}>{snapshot.signature}</p>
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
      </div>

      <div class="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-bark-100">
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-shadow-900">{snapshot.scannedFiles}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Discovered Files</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-gold-600">{snapshot.loadedSkills}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Loaded Skills</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-serif font-bold text-moss-600">{snapshot.includedSkills.length}</p>
          <p class="text-xs text-shadow-600 uppercase tracking-wide mt-1">Injected Skills</p>
        </div>
      </div>

      <!-- Budget -->
      <div class="mt-4 pt-4 border-t border-bark-100">
        <p class="text-xs text-shadow-600 uppercase tracking-wide mb-2">Budget</p>
        <div class="flex gap-4">
          <span class="text-sm text-shadow-800">
            <code class="font-mono bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">maxSkills={snapshot.budget.maxSkills}</code>
          </span>
          <span class="text-sm text-shadow-800">
            <code class="font-mono bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">maxChars={snapshot.budget.maxChars.toLocaleString()}</code>
          </span>
        </div>
      </div>

      <!-- Discovery Order -->
      {#if snapshot.directories.length > 0}
        <div class="mt-4 pt-4 border-t border-bark-100">
          <p class="text-xs text-shadow-600 uppercase tracking-wide mb-2">Discovery Order</p>
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
    </div>

    <!-- Injected Skills Table -->
    <div class="card-garden overflow-hidden">
      <div class="px-5 pt-4 pb-2">
        <h2 class="text-base font-serif font-semibold text-shadow-900">Injected Skills</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-bark-200 bg-bark-100">
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Name</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Description</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Path</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Source</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Always</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Requires</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Chars</th>
            </tr>
          </thead>
          <tbody>
            {#if snapshot.includedSkills.length === 0}
              <tr>
                <td colspan="7" class="px-4 py-8 text-center text-sm text-shadow-600">
                  No skills injected into runtime context.
                </td>
              </tr>
            {:else}
              {#each snapshot.includedSkills as skill (skill.id)}
                <tr class="border-b border-bark-100 hover:bg-bark-50 transition-colors">
                  <td class="px-4 py-3">
                    <strong class="text-shadow-800">{skill.name}</strong>
                  </td>
                  <td class="px-4 py-3 text-shadow-700">{skill.description}</td>
                  <td class="px-4 py-3">
                    <code class="text-sm font-mono text-shadow-600">{skill.relativePath}</code>
                  </td>
                  <td class="px-4 py-3 text-shadow-700">{skill.source}</td>
                  <td class="px-4 py-3">
                    <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {skill.always ? 'bg-moss-100 text-moss-700' : 'bg-bark-200 text-shadow-600'}">
                      {skill.always ? 'yes' : 'no'}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    {#if formatRequires(skill) === 'none'}
                      <span class="text-shadow-600 text-sm">none</span>
                    {:else}
                      <code class="text-sm font-mono text-shadow-700">{formatRequires(skill)}</code>
                    {/if}
                  </td>
                  <td class="px-4 py-3 text-sm font-mono text-shadow-700">
                    {skill.content.length.toLocaleString()}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Filtered / Skipped Table -->
    <div class="card-garden overflow-hidden">
      <div class="px-5 pt-4 pb-2">
        <h2 class="text-base font-serif font-semibold text-shadow-900">Filtered / Skipped</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-bark-200 bg-bark-100">
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Kind</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Name</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Path</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Source</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Reason</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Details</th>
            </tr>
          </thead>
          <tbody>
            {#if snapshot.skipped.length === 0}
              <tr>
                <td colspan="6" class="px-4 py-8 text-center text-sm text-shadow-600">
                  No filtered skills.
                </td>
              </tr>
            {:else}
              {#each snapshot.skipped as item}
                <tr class="border-b border-bark-100 hover:bg-bark-50 transition-colors">
                  <td class="px-4 py-3">
                    <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-bark-200 text-shadow-700">
                      {item.kind}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-shadow-800">{item.name}</td>
                  <td class="px-4 py-3">
                    <code class="text-sm font-mono text-shadow-600">{item.relativePath}</code>
                  </td>
                  <td class="px-4 py-3 text-shadow-700">{item.source}</td>
                  <td class="px-4 py-3 text-shadow-700">{item.reason}</td>
                  <td class="px-4 py-3 text-sm text-shadow-600">
                    {item.details ? item.details.join('; ') : ''}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
