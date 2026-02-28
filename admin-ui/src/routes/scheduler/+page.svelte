<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getSchedulerData,
    updateSchedulerTask,
    createSchedulerTask,
    removeSchedulerTask,
    updateReflectionTemplate,
  } from '$lib/api/endpoints/scheduler';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import type { ScheduledTask, ReflectionTemplate, TaskType } from '$lib/types';

  // ── State ──
  let tasks = $state<ScheduledTask[]>([]);
  let reflections = $state<ReflectionTemplate[]>([]);
  let loading = $state(true);
  let error = $state('');
  let dashboardTaskCount = $state<number | null>(null);
  let useFallback = $state(false);
  let saving = $state<string | null>(null);
  let feedback = $state<{ type: 'ok' | 'error'; message: string } | null>(null);

  // ── New task form ──
  let showNewTaskForm = $state(false);
  let newTask = $state({
    id: '',
    name: '',
    type: 'every' as TaskType,
    interval: '',
    runAt: '',
  });

  // ── Editing state ──
  let editingIntervals = $state<Record<string, string>>({});
  let expandedReflections = $state<Set<string>>(new Set());
  let editingPrompts = $state<Record<string, string>>({});

  // ── Task state styling ──
  const STATE_BADGE: Record<string, string> = {
    idle:     'bg-bark-200 text-shadow-700',
    active:   'bg-moss-100 text-moss-700',
    paused:   'bg-gold-100 text-gold-700',
    complete: 'bg-bark-200 text-shadow-600',
  };

  const STATE_DOT: Record<string, string> = {
    idle:     'bg-bark-400',
    active:   'bg-moss-400',
    paused:   'bg-gold-400',
    complete: 'bg-shadow-300',
  };

  const TYPE_BADGE: Record<string, string> = {
    every:      'bg-gold-100 text-gold-700',
    'one-shot': 'bg-petal-100 text-petal-500',
  };

  // ── Interval parsing and formatting ──
  function msToHuman(ms: number): string {
    if (ms <= 0) return '--';
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }

  function parseHumanInterval(input: string): number | null {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;

    // Try pure number (ms)
    if (/^\d+$/.test(trimmed)) {
      const ms = parseInt(trimmed, 10);
      return ms > 0 ? ms : null;
    }

    let totalMs = 0;
    const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s|ms)/g;
    let match: RegExpExecArray | null;
    let anyMatch = false;

    while ((match = regex.exec(trimmed)) !== null) {
      anyMatch = true;
      const val = parseFloat(match[1]);
      const unit = match[2];
      switch (unit) {
        case 'd':  totalMs += val * 86_400_000; break;
        case 'h':  totalMs += val * 3_600_000; break;
        case 'm':  totalMs += val * 60_000; break;
        case 's':  totalMs += val * 1_000; break;
        case 'ms': totalMs += val; break;
      }
    }

    if (!anyMatch) return null;
    return Math.round(totalMs) || null;
  }

  function formatInterval(task: ScheduledTask): string {
    if (task.type === 'every') {
      return msToHuman(task.intervalMs);
    }
    if (task.runAt) {
      return new Date(task.runAt).toLocaleString();
    }
    return '--';
  }

  // ── Protected tasks ──
  const PROTECTED_TASKS = new Set(['heartbeat', 'salience-decay', 'maintenance']);
  function isProtected(id: string): boolean {
    return PROTECTED_TASKS.has(id);
  }

  // ── Data loading ──
  async function loadData() {
    loading = true;
    error = '';

    try {
      const data = await getSchedulerData();
      tasks = data.tasks;
      reflections = data.reflections ?? [];
      useFallback = false;
      loading = false;

      // Initialize editing intervals from current values
      editingIntervals = {};
      for (const task of tasks) {
        if (task.type === 'every') {
          editingIntervals[task.id] = msToHuman(task.intervalMs);
        }
      }
      return;
    } catch {
      // Endpoint may not exist yet -- fall back to dashboard stats
    }

    try {
      const dashData = await getDashboard();
      dashboardTaskCount = dashData.stats.schedulerTasks;
      useFallback = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load scheduler data';
    } finally {
      loading = false;
    }
  }

  // ── Feedback ──
  function showFeedback(type: 'ok' | 'error', message: string) {
    feedback = { type, message };
    setTimeout(() => { feedback = null; }, 4000);
  }

  // ── Task mutations ──
  async function saveTaskInterval(task: ScheduledTask) {
    const input = editingIntervals[task.id];
    const ms = parseHumanInterval(input ?? '');
    if (!ms) {
      showFeedback('error', 'Invalid interval. Use format like "1h", "30m", "5m 30s".');
      return;
    }
    saving = `interval:${task.id}`;
    try {
      const result = await updateSchedulerTask(task.id, { intervalMs: ms });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update task');
    } finally {
      saving = null;
    }
  }

  async function toggleTaskEnabled(task: ScheduledTask) {
    const isCurrentlyEnabled = task.state !== 'paused';
    saving = `toggle:${task.id}`;
    try {
      const result = await updateSchedulerTask(task.id, { enabled: !isCurrentlyEnabled });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to toggle task');
    } finally {
      saving = null;
    }
  }

  async function handleRemoveTask(task: ScheduledTask) {
    if (!confirm(`Remove task "${task.name}"? This cannot be undone.`)) return;
    saving = `remove:${task.id}`;
    try {
      const result = await removeSchedulerTask(task.id);
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to remove task');
    } finally {
      saving = null;
    }
  }

  async function handleCreateTask() {
    const ms = newTask.type === 'every' ? parseHumanInterval(newTask.interval) : undefined;
    if (newTask.type === 'every' && !ms) {
      showFeedback('error', 'Invalid interval for recurring task.');
      return;
    }
    if (!newTask.id.trim() || !newTask.name.trim()) {
      showFeedback('error', 'Task ID and name are required.');
      return;
    }

    saving = 'create-task';
    try {
      const result = await createSchedulerTask({
        id: newTask.id.trim(),
        name: newTask.name.trim(),
        type: newTask.type,
        intervalMs: ms ?? undefined,
        runAt: newTask.type === 'one-shot' && newTask.runAt
          ? new Date(newTask.runAt).getTime()
          : undefined,
      });
      if (result.ok) {
        showFeedback('ok', result.message);
        newTask = { id: '', name: '', type: 'every', interval: '', runAt: '' };
        showNewTaskForm = false;
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to create task');
    } finally {
      saving = null;
    }
  }

  // ── Reflection mutations ──
  function toggleReflectionExpanded(id: string) {
    const next = new Set(expandedReflections);
    if (next.has(id)) {
      next.delete(id);
      delete editingPrompts[id];
    } else {
      next.add(id);
      const tpl = reflections.find(r => r.id === id);
      if (tpl) editingPrompts[id] = tpl.prompt;
    }
    expandedReflections = next;
  }

  async function saveReflectionPrompt(tpl: ReflectionTemplate) {
    const newPrompt = editingPrompts[tpl.id];
    if (!newPrompt || newPrompt.length < 10) {
      showFeedback('error', 'Prompt must be at least 10 characters.');
      return;
    }
    saving = `reflection-prompt:${tpl.id}`;
    try {
      const result = await updateReflectionTemplate(tpl.id, { prompt: newPrompt });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update reflection');
    } finally {
      saving = null;
    }
  }

  async function toggleReflectionEnabled(tpl: ReflectionTemplate) {
    saving = `reflection-toggle:${tpl.id}`;
    try {
      const result = await updateReflectionTemplate(tpl.id, { enabled: !tpl.enabled });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to toggle reflection');
    } finally {
      saving = null;
    }
  }

  async function saveReflectionInterval(tpl: ReflectionTemplate, input: string) {
    const ms = parseHumanInterval(input);
    if (!ms) {
      showFeedback('error', 'Invalid interval. Use format like "1h", "30m", "8h".');
      return;
    }
    saving = `reflection-interval:${tpl.id}`;
    try {
      const result = await updateReflectionTemplate(tpl.id, { intervalMs: ms });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update reflection interval');
    } finally {
      saving = null;
    }
  }

  async function toggleReflectionDiscord(tpl: ReflectionTemplate) {
    saving = `reflection-discord:${tpl.id}`;
    try {
      const result = await updateReflectionTemplate(tpl.id, { sendToDiscord: !tpl.sendToDiscord });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to toggle Discord setting');
    } finally {
      saving = null;
    }
  }

  // ── Auto-refresh every 30s ──
  let refreshInterval: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    loadData();
    refreshInterval = setInterval(loadData, 30_000);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Rhythms</h1>
      <p class="text-sm text-shadow-600 mt-1">Scheduled tasks, heartbeats, reflections, and one-shot work</p>
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

  <!-- Feedback toast -->
  {#if feedback}
    <div
      class="fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all
             {feedback.type === 'ok'
               ? 'bg-moss-100 text-moss-800 border border-moss-300'
               : 'bg-wilt-50 text-wilt-700 border border-wilt-300'}"
    >
      {feedback.message}
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading scheduler data...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if useFallback}
    <!-- Fallback: only dashboard task count available -->
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
            The scheduler task list is available when the agent is running with an active gateway.
            Dashboard reports <strong class="text-shadow-900 font-serif text-lg">{dashboardTaskCount}</strong> scheduled tasks registered.
          </p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Registered</p>
        <p class="text-3xl font-serif font-bold text-gold-600">{dashboardTaskCount ?? 0}</p>
      </div>
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: Every</p>
        <p class="text-sm text-shadow-700">Recurring interval tasks (heartbeat, decay, maintenance)</p>
      </div>
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: One-Shot</p>
        <p class="text-sm text-shadow-700">Single-fire tasks (scheduled by agent)</p>
      </div>
    </div>
  {:else if tasks.length === 0 && reflections.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No scheduled tasks</p>
      <p class="text-sm text-shadow-600">Tasks will appear here when the scheduler registers heartbeats, maintenance, and agent-scheduled work.</p>
    </div>
  {:else}
    <!-- Task summary -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Total</p>
        <p class="text-2xl font-serif font-bold text-shadow-900">{tasks.length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Active</p>
        <p class="text-2xl font-serif font-bold text-moss-600">{tasks.filter(t => t.state === 'active').length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Idle</p>
        <p class="text-2xl font-serif font-bold text-shadow-700">{tasks.filter(t => t.state === 'idle').length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Paused</p>
        <p class="text-2xl font-serif font-bold text-gold-600">{tasks.filter(t => t.state === 'paused').length}</p>
      </div>
    </div>

    <!-- Task table -->
    <div class="card-garden overflow-hidden">
      <div class="px-4 py-3 border-b border-bark-200 bg-bark-50 flex items-center justify-between">
        <h2 class="font-serif font-semibold text-shadow-800">Scheduled Tasks</h2>
        <button
          onclick={() => showNewTaskForm = !showNewTaskForm}
          class="text-xs px-3 py-1.5 rounded-lg border border-gold-300 bg-gold-50
                 text-gold-700 hover:bg-gold-100 transition-colors font-medium"
        >
          {showNewTaskForm ? 'Cancel' : '+ Add Task'}
        </button>
      </div>

      <!-- New task form -->
      {#if showNewTaskForm}
        <div class="px-4 py-4 border-b border-bark-200 bg-bark-50/50">
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label for="new-task-id" class="block text-xs font-medium text-shadow-600 mb-1">ID (slug)</label>
              <input
                id="new-task-id"
                type="text"
                bind:value={newTask.id}
                placeholder="my-task"
                class="w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              />
            </div>
            <div>
              <label for="new-task-name" class="block text-xs font-medium text-shadow-600 mb-1">Name</label>
              <input
                id="new-task-name"
                type="text"
                bind:value={newTask.name}
                placeholder="My Task"
                class="w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              />
            </div>
            <div>
              <label for="new-task-type" class="block text-xs font-medium text-shadow-600 mb-1">Type</label>
              <select
                id="new-task-type"
                bind:value={newTask.type}
                class="w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              >
                <option value="every">Recurring (every)</option>
                <option value="one-shot">One-Shot</option>
              </select>
            </div>
            {#if newTask.type === 'every'}
              <div>
                <label for="new-task-interval" class="block text-xs font-medium text-shadow-600 mb-1">Interval</label>
                <input
                  id="new-task-interval"
                  type="text"
                  bind:value={newTask.interval}
                  placeholder="1h, 30m, 5m 30s"
                  class="w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                         bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                />
              </div>
            {:else}
              <div>
                <label for="new-task-runat" class="block text-xs font-medium text-shadow-600 mb-1">Run At</label>
                <input
                  id="new-task-runat"
                  type="datetime-local"
                  bind:value={newTask.runAt}
                  class="w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                         bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                />
              </div>
            {/if}
          </div>
          <div class="mt-3 flex justify-end">
            <button
              onclick={handleCreateTask}
              disabled={saving === 'create-task'}
              class="text-sm px-4 py-1.5 rounded-lg bg-moss-600 text-white
                     hover:bg-moss-700 transition-colors disabled:opacity-50 font-medium"
            >
              {saving === 'create-task' ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </div>
      {/if}

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-bark-200 bg-bark-100">
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Name</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Type</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Interval / Run At</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">State</th>
              <th class="text-right px-4 py-3 font-semibold text-shadow-800">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each tasks as task (task.id)}
              <tr class="border-b border-bark-100 hover:bg-bark-50 transition-colors">
                <td class="px-4 py-3">
                  <code class="text-sm font-mono text-shadow-800">{task.name}</code>
                  <span class="text-xs text-shadow-500 block font-mono">{task.id}</span>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {TYPE_BADGE[task.type] || 'bg-bark-200 text-shadow-600'}">
                    {task.type}
                  </span>
                </td>
                <td class="px-4 py-3">
                  {#if task.type === 'every'}
                    <div class="flex items-center gap-2">
                      <input
                        type="text"
                        value={editingIntervals[task.id] ?? msToHuman(task.intervalMs)}
                        oninput={(e) => { editingIntervals[task.id] = (e.target as HTMLInputElement).value; }}
                        class="w-24 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                               bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                      />
                      <button
                        onclick={() => saveTaskInterval(task)}
                        disabled={saving === `interval:${task.id}`}
                        class="text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                               text-moss-700 hover:bg-moss-100 transition-colors
                               disabled:opacity-50 font-medium"
                      >
                        {saving === `interval:${task.id}` ? '...' : 'Save'}
                      </button>
                    </div>
                  {:else}
                    <span class="text-sm text-shadow-700 font-mono">{formatInterval(task)}</span>
                  {/if}
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium {STATE_BADGE[task.state] || 'bg-bark-200 text-shadow-600'}">
                    <span class="w-1.5 h-1.5 rounded-full {STATE_DOT[task.state] || 'bg-bark-400'}" class:animate-pulse={task.state === 'active'}></span>
                    {task.state}
                  </span>
                </td>
                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end gap-2">
                    {#if task.type === 'every'}
                      <button
                        onclick={() => toggleTaskEnabled(task)}
                        disabled={saving === `toggle:${task.id}`}
                        class="text-xs px-2 py-1 rounded border transition-colors font-medium disabled:opacity-50
                               {task.state === 'paused'
                                 ? 'border-moss-300 bg-moss-50 text-moss-700 hover:bg-moss-100'
                                 : 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100'}"
                      >
                        {task.state === 'paused' ? 'Enable' : 'Pause'}
                      </button>
                    {/if}
                    {#if !isProtected(task.id)}
                      <button
                        onclick={() => handleRemoveTask(task)}
                        disabled={saving === `remove:${task.id}`}
                        class="text-xs px-2 py-1 rounded border border-wilt-300 bg-wilt-50
                               text-wilt-600 hover:bg-wilt-100 transition-colors
                               disabled:opacity-50 font-medium"
                      >
                        Remove
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Reflection templates -->
    {#if reflections.length > 0}
      <div class="card-garden overflow-hidden">
        <div class="px-4 py-3 border-b border-bark-200 bg-bark-50">
          <h2 class="font-serif font-semibold text-shadow-800">Reflection Templates</h2>
          <p class="text-xs text-shadow-600 mt-0.5">Heartbeat-driven inner reflections. Edit prompts, intervals, and toggle Discord visibility.</p>
        </div>

        <div class="divide-y divide-bark-100">
          {#each reflections as tpl (tpl.id)}
            <div class="px-4 py-4">
              <!-- Template header -->
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3 min-w-0">
                  <button
                    onclick={() => toggleReflectionExpanded(tpl.id)}
                    class="text-shadow-500 hover:text-shadow-700 transition-colors shrink-0"
                    aria-label={expandedReflections.has(tpl.id) ? 'Collapse' : 'Expand'}
                  >
                    <svg class="w-4 h-4 transition-transform {expandedReflections.has(tpl.id) ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-shadow-800">{tpl.name}</span>
                      <code class="text-xs text-shadow-500 font-mono">{tpl.id}</code>
                      {#if tpl.mode === 'deliberation'}
                        <span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-petal-100 text-petal-600">deliberation</span>
                      {/if}
                    </div>
                    <p class="text-xs text-shadow-600 mt-0.5 truncate">{tpl.prompt.slice(0, 80)}{tpl.prompt.length > 80 ? '...' : ''}</p>
                  </div>
                </div>

                <div class="flex items-center gap-3 shrink-0">
                  <!-- Interval -->
                  <div class="flex items-center gap-1.5">
                    <label for="refl-interval-{tpl.id}" class="sr-only">Interval</label>
                    <input
                      id="refl-interval-{tpl.id}"
                      type="text"
                      value={msToHuman(tpl.intervalMs)}
                      onchange={(e) => saveReflectionInterval(tpl, (e.target as HTMLInputElement).value)}
                      class="w-16 px-2 py-1 text-xs font-mono border border-bark-300 rounded
                             bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                    />
                  </div>

                  <!-- Send to Discord toggle -->
                  <button
                    onclick={() => toggleReflectionDiscord(tpl)}
                    disabled={saving === `reflection-discord:${tpl.id}`}
                    class="flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors font-medium disabled:opacity-50
                           {tpl.sendToDiscord
                             ? 'border-petal-300 bg-petal-50 text-petal-600'
                             : 'border-bark-300 bg-bark-50 text-shadow-600'}"
                    title={tpl.sendToDiscord ? 'Sends to Discord' : 'Internal only'}
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    {tpl.sendToDiscord ? 'Discord' : 'Silent'}
                  </button>

                  <!-- Enabled toggle -->
                  <button
                    onclick={() => toggleReflectionEnabled(tpl)}
                    disabled={saving === `reflection-toggle:${tpl.id}`}
                    class="text-xs px-2 py-1 rounded border transition-colors font-medium disabled:opacity-50
                           {tpl.enabled
                             ? 'border-moss-300 bg-moss-50 text-moss-700'
                             : 'border-shadow-300 bg-shadow-50 text-shadow-600'}"
                  >
                    {tpl.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </div>

              <!-- Expanded prompt editor -->
              {#if expandedReflections.has(tpl.id)}
                <div class="mt-3 ml-7">
                  <label for="refl-prompt-{tpl.id}" class="block text-xs font-medium text-shadow-600 mb-1">Prompt</label>
                  <textarea
                    id="refl-prompt-{tpl.id}"
                    bind:value={editingPrompts[tpl.id]}
                    rows="4"
                    class="w-full px-3 py-2 text-sm border border-bark-300 rounded-md
                           bg-white text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400
                           resize-y font-sans"
                  ></textarea>
                  <div class="flex items-center justify-between mt-2">
                    <span class="text-xs text-shadow-500">{(editingPrompts[tpl.id] ?? '').length} chars</span>
                    <button
                      onclick={() => saveReflectionPrompt(tpl)}
                      disabled={saving === `reflection-prompt:${tpl.id}` || editingPrompts[tpl.id] === tpl.prompt}
                      class="text-xs px-3 py-1.5 rounded-lg bg-moss-600 text-white
                             hover:bg-moss-700 transition-colors disabled:opacity-50 font-medium"
                    >
                      {saving === `reflection-prompt:${tpl.id}` ? 'Saving...' : 'Save Prompt'}
                    </button>
                  </div>
                  {#if tpl.mode === 'deliberation' && tpl.deliberation}
                    <div class="mt-2 p-2.5 bg-bark-50 rounded-md border border-bark-200">
                      <p class="text-xs font-medium text-shadow-600 mb-1">Deliberation Config</p>
                      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-shadow-700">
                        {#if tpl.deliberation.maxRounds}
                          <div><span class="text-shadow-500">Rounds:</span> {tpl.deliberation.maxRounds}</div>
                        {/if}
                        {#if tpl.deliberation.maxTotalTokens}
                          <div><span class="text-shadow-500">Tokens:</span> {tpl.deliberation.maxTotalTokens.toLocaleString()}</div>
                        {/if}
                        {#if tpl.deliberation.maxWallTimeMs}
                          <div><span class="text-shadow-500">Time:</span> {msToHuman(tpl.deliberation.maxWallTimeMs)}</div>
                        {/if}
                        {#if tpl.deliberation.voices}
                          <div><span class="text-shadow-500">Voices:</span> {tpl.deliberation.voices.join(', ')}</div>
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
