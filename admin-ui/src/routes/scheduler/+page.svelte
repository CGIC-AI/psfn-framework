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
  import { schedulerLoadErrorMessage, shouldUseSchedulerFallback } from '$lib/scheduler/fallback';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import type {
    RecurringCadence,
    ReflectionTemplate,
    ScheduledTask,
    SchedulerCadenceTimezone,
    TaskType,
  } from '$lib/types';

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
  type CadenceEditorMode = 'relative' | 'hourly' | 'daily' | 'weekly';
  type CadenceEditorState = {
    mode: CadenceEditorMode;
    dayOfWeek: string;
    hour: string;
    minute: string;
    timezone: SchedulerCadenceTimezone;
  };

  const REFLECTION_TASK_PREFIX = 'reflection:';
  const DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
  const KNOWN_REFLECTION_CADENCE: Record<string, RecurringCadence> = {
    'daily-review': { kind: 'daily', hour: 6, minute: 0, timezone: 'local' },
    'weekly-review': { kind: 'weekly', dayOfWeek: 0, hour: 7, minute: 0, timezone: 'local' },
  };
  const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let editingIntervals = $state<Record<string, string>>({});
  let editingCadence = $state<Record<string, CadenceEditorState>>({});
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

  function formatTwoDigits(value: number): string {
    return String(value).padStart(2, '0');
  }

  function parseBoundedInt(input: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(input.trim())) return null;
    const parsed = Number.parseInt(input, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
    return parsed;
  }

  function getReflectionTemplateId(taskId: string): string | null {
    if (!taskId.startsWith(REFLECTION_TASK_PREFIX)) return null;
    if (taskId.startsWith(DEFERRED_REFLECTION_TASK_PREFIX)) return null;
    const templateId = taskId.slice(REFLECTION_TASK_PREFIX.length).trim();
    return templateId.length > 0 ? templateId : null;
  }

  function isReflectionTask(task: ScheduledTask): boolean {
    return getReflectionTemplateId(task.id) !== null;
  }

  function hasCadenceControls(task: ScheduledTask): boolean {
    return task.type === 'every' && (isReflectionTask(task) || task.cadence !== undefined);
  }

  function getPreferredReflectionCadence(task: ScheduledTask): RecurringCadence | undefined {
    const templateId = getReflectionTemplateId(task.id);
    if (!templateId) return undefined;
    return KNOWN_REFLECTION_CADENCE[templateId];
  }

  function resolveTaskCadence(task: ScheduledTask): RecurringCadence {
    return task.cadence ?? getPreferredReflectionCadence(task) ?? { kind: 'relative' };
  }

  function cadenceToEditorState(task: ScheduledTask): CadenceEditorState {
    const cadence = resolveTaskCadence(task);
    if (cadence.kind === 'daily') {
      return {
        mode: 'daily',
        dayOfWeek: '0',
        hour: String(cadence.hour),
        minute: String(cadence.minute),
        timezone: cadence.timezone,
      };
    }
    if (cadence.kind === 'weekly') {
      return {
        mode: 'weekly',
        dayOfWeek: String(cadence.dayOfWeek),
        hour: String(cadence.hour),
        minute: String(cadence.minute),
        timezone: cadence.timezone,
      };
    }
    if (cadence.kind === 'hourly') {
      return {
        mode: 'hourly',
        dayOfWeek: '0',
        hour: '0',
        minute: String(cadence.minute),
        timezone: cadence.timezone,
      };
    }
    return {
      mode: 'relative',
      dayOfWeek: '0',
      hour: '0',
      minute: '0',
      timezone: 'local',
    };
  }

  function getCadenceEditor(task: ScheduledTask): CadenceEditorState {
    return editingCadence[task.id] ?? cadenceToEditorState(task);
  }

  function updateCadenceEditor(task: ScheduledTask, patch: Partial<CadenceEditorState>) {
    const current = getCadenceEditor(task);
    editingCadence[task.id] = { ...current, ...patch };
  }

  function formatInterval(task: ScheduledTask): string {
    if (task.type === 'every') {
      const cadence = task.cadence;
      if (cadence?.kind === 'hourly') {
        return `Hourly @ :${formatTwoDigits(cadence.minute)} (${cadence.timezone.toUpperCase()})`;
      }
      if (cadence?.kind === 'daily') {
        return `Daily @ ${formatTwoDigits(cadence.hour)}:${formatTwoDigits(cadence.minute)} (${cadence.timezone.toUpperCase()})`;
      }
      if (cadence?.kind === 'weekly') {
        return `Weekly ${WEEKDAY_LABELS[cadence.dayOfWeek] ?? `day ${cadence.dayOfWeek}`} @ ${formatTwoDigits(cadence.hour)}:${formatTwoDigits(cadence.minute)} (${cadence.timezone.toUpperCase()})`;
      }
      return msToHuman(task.intervalMs);
    }
    if (task.runAt) {
      return new Date(task.runAt).toLocaleString();
    }
    return '--';
  }

  function getReflectionScheduleLabel(tpl: ReflectionTemplate): string {
    const linkedTask = tasks.find(task => task.id === `reflection:${tpl.id}`);
    if (linkedTask) {
      return formatInterval(linkedTask);
    }
    return formatInterval({
      id: `reflection:${tpl.id}`,
      name: tpl.name,
      type: 'every',
      intervalMs: tpl.intervalMs,
      cadence: tpl.cadence,
      state: tpl.enabled ? 'idle' : 'paused',
    });
  }

  function isReflectionEnabled(tpl: ReflectionTemplate): boolean {
    return tpl.enabled !== false;
  }

  // ── Protected tasks ──
  const PROTECTED_TASKS = new Set(['heartbeat', 'background-maintenance', 'maintenance']);
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
      editingCadence = {};
      for (const task of tasks) {
        if (task.type === 'every') {
          editingIntervals[task.id] = msToHuman(task.intervalMs);
          editingCadence[task.id] = cadenceToEditorState(task);
        }
      }
      return;
    } catch (schedulerError) {
      if (!shouldUseSchedulerFallback(schedulerError)) {
        useFallback = false;
        error = schedulerLoadErrorMessage(schedulerError);
        loading = false;
        return;
      }

      // Endpoint may not exist yet -- fall back to dashboard stats
    }

    try {
      const dashData = await getDashboard();
      dashboardTaskCount = dashData.stats.schedulerTasks;
      useFallback = true;
    } catch (dashboardError) {
      error = schedulerLoadErrorMessage(dashboardError);
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

  async function saveTaskCadence(task: ScheduledTask) {
    if (task.type !== 'every') return;

    const editor = getCadenceEditor(task);
    let cadence: RecurringCadence;
    let intervalMs: number;

    if (editor.mode === 'relative') {
      const input = editingIntervals[task.id] ?? '';
      const parsedInterval = parseHumanInterval(input);
      if (!parsedInterval) {
        showFeedback('error', 'Invalid interval. Use format like "1h", "30m", "5m 30s".');
        return;
      }
      cadence = { kind: 'relative' };
      intervalMs = parsedInterval;
    } else if (editor.mode === 'hourly') {
      const minute = parseBoundedInt(editor.minute, 0, 59);
      if (minute === null) {
        showFeedback('error', 'Hourly cadence minute must be an integer from 0 to 59.');
        return;
      }
      cadence = {
        kind: 'hourly',
        minute,
        timezone: editor.timezone,
      };
      intervalMs = 60 * 60_000;
    } else if (editor.mode === 'daily') {
      const hour = parseBoundedInt(editor.hour, 0, 23);
      const minute = parseBoundedInt(editor.minute, 0, 59);
      if (hour === null || minute === null) {
        showFeedback('error', 'Daily cadence requires hour 0-23 and minute 0-59.');
        return;
      }
      cadence = {
        kind: 'daily',
        hour,
        minute,
        timezone: editor.timezone,
      };
      intervalMs = 24 * 60 * 60_000;
    } else {
      const dayOfWeek = parseBoundedInt(editor.dayOfWeek, 0, 6);
      const hour = parseBoundedInt(editor.hour, 0, 23);
      const minute = parseBoundedInt(editor.minute, 0, 59);
      if (dayOfWeek === null || hour === null || minute === null) {
        showFeedback('error', 'Weekly cadence requires day 0-6, hour 0-23, and minute 0-59.');
        return;
      }
      cadence = {
        kind: 'weekly',
        dayOfWeek,
        hour,
        minute,
        timezone: editor.timezone,
      };
      intervalMs = 7 * 24 * 60 * 60_000;
    }

    saving = `cadence:${task.id}`;
    try {
      const result = await updateSchedulerTask(task.id, {
        intervalMs,
        cadence,
      });
      if (result.ok) {
        showFeedback('ok', result.message);
        await loadData();
      } else {
        showFeedback('error', result.message);
      }
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update cadence');
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
    saving = `reflection-enabled:${tpl.id}`;
    try {
      const result = await updateReflectionTemplate(tpl.id, { enabled: !isReflectionEnabled(tpl) });
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

  const refreshPoller = createVisibilityAwarePoller({
    refresh: loadData,
    intervalMs: 30_000,
  });

  onMount(() => {
    refreshPoller.start();
  });

  onDestroy(() => {
    refreshPoller.stop();
  });
</script>

<div class="garden-page space-y-4">
  <GardenPageHeader
    eyebrow="Live Operations"
    title="The Rhythms"
    description="Scheduled tasks, heartbeats, reflections, and one-shot work."
  >
    {#snippet actions()}
      <button
        onclick={loadData}
        disabled={loading}
        class="garden-action min-h-11 rounded-lg border border-bark-300 px-4 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    {/snippet}
  </GardenPageHeader>

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
    <div class="garden-loading card-garden p-8 text-center" aria-busy="true" aria-live="polite">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading scheduler data...</p>
    </div>
  {:else if error}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-6" role="alert">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if useFallback}
    <!-- Fallback: only dashboard task count available -->
    <div class="garden-section card-garden p-6">
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

    <div class="garden-metric-grid grid grid-cols-1 gap-4 md:grid-cols-3">
      <div class="garden-metric card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Registered</p>
        <p class="text-3xl font-serif font-bold text-gold-600">{dashboardTaskCount ?? 0}</p>
      </div>
      <div class="garden-metric card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: Every</p>
        <p class="text-sm text-shadow-700">Recurring interval tasks (heartbeat, decay, maintenance)</p>
      </div>
      <div class="garden-metric card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: One-Shot</p>
        <p class="text-sm text-shadow-700">Single-fire tasks (scheduled by agent)</p>
      </div>
    </div>
  {:else if tasks.length === 0 && reflections.length === 0}
    <div class="garden-empty card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No scheduled tasks</p>
      <p class="text-sm text-shadow-600">Tasks will appear here when the scheduler registers heartbeats, maintenance, and agent-scheduled work.</p>
    </div>
  {:else}
    <!-- Task summary -->
    <div class="garden-metric-grid grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="garden-metric card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Total</p>
        <p class="text-2xl font-serif font-bold text-shadow-900">{tasks.length}</p>
      </div>
      <div class="garden-metric card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Active</p>
        <p class="text-2xl font-serif font-bold text-moss-600">{tasks.filter(t => t.state === 'active').length}</p>
      </div>
      <div class="garden-metric card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Idle</p>
        <p class="text-2xl font-serif font-bold text-shadow-700">{tasks.filter(t => t.state === 'idle').length}</p>
      </div>
      <div class="garden-metric card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Paused</p>
        <p class="text-2xl font-serif font-bold text-gold-600">{tasks.filter(t => t.state === 'paused').length}</p>
      </div>
    </div>

    <!-- Task table -->
    <div class="garden-section garden-table-shell card-garden overflow-hidden">
      <div class="garden-section-header px-4 py-3 border-b border-bark-200 bg-bark-50 flex items-center justify-between">
        <h2 class="font-serif font-semibold text-shadow-800">Scheduled Tasks</h2>
        <button
          onclick={() => showNewTaskForm = !showNewTaskForm}
          class="garden-action min-h-11 text-xs px-3 py-1.5 rounded-lg border border-gold-300 bg-gold-50
                 text-gold-700 hover:bg-gold-100 transition-colors font-medium"
        >
          {showNewTaskForm ? 'Cancel' : '+ Add Task'}
        </button>
      </div>

      <!-- New task form -->
      {#if showNewTaskForm}
        <div class="garden-toolbar px-4 py-4 border-b border-bark-200 bg-bark-50/50">
          <div class="garden-field-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="garden-field">
              <label for="new-task-id" class="block text-xs font-medium text-shadow-600 mb-1">ID (slug)</label>
              <input
                id="new-task-id"
                type="text"
                bind:value={newTask.id}
                placeholder="my-task"
                class="min-h-11 w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              />
            </div>
            <div class="garden-field">
              <label for="new-task-name" class="block text-xs font-medium text-shadow-600 mb-1">Name</label>
              <input
                id="new-task-name"
                type="text"
                bind:value={newTask.name}
                placeholder="My Task"
                class="min-h-11 w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              />
            </div>
            <div class="garden-field">
              <label for="new-task-type" class="block text-xs font-medium text-shadow-600 mb-1">Type</label>
              <select
                id="new-task-type"
                bind:value={newTask.type}
                class="min-h-11 w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                       bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
              >
                <option value="every">Recurring (every)</option>
                <option value="one-shot">One-Shot</option>
              </select>
            </div>
            {#if newTask.type === 'every'}
              <div class="garden-field">
                <label for="new-task-interval" class="block text-xs font-medium text-shadow-600 mb-1">Interval</label>
                <input
                  id="new-task-interval"
                  type="text"
                  bind:value={newTask.interval}
                  placeholder="1h, 30m, 5m 30s"
                  class="min-h-11 w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                         bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                />
              </div>
            {:else}
              <div class="garden-field">
                <label for="new-task-runat" class="block text-xs font-medium text-shadow-600 mb-1">Run At</label>
                <input
                  id="new-task-runat"
                  type="datetime-local"
                  bind:value={newTask.runAt}
                  class="min-h-11 w-full px-2.5 py-1.5 text-sm border border-bark-300 rounded-md
                         bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                />
              </div>
            {/if}
          </div>
          <div class="mt-3 flex justify-end">
            <button
              onclick={handleCreateTask}
              disabled={saving === 'create-task'}
              class="garden-action garden-action--primary min-h-11 text-sm px-4 py-1.5 rounded-lg bg-moss-600 text-white
                     hover:bg-moss-700 transition-colors disabled:opacity-50 font-medium"
            >
              {saving === 'create-task' ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </div>
      {/if}

      <div class="garden-table-scroll overflow-x-auto">
        <table class="garden-table w-full text-sm">
          <thead>
            <tr class="border-b border-bark-200 bg-bark-100">
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Name</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Type</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Cadence / Interval / Run At</th>
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
                  {#if task.description}
                    <p class="mt-1 max-w-xl text-xs text-shadow-600">{task.description}</p>
                  {/if}
                  {#if task.scheduleSource}
                    <p class="mt-1 text-[11px] text-shadow-500">
                      Shared cadence: <code class="font-mono">{task.scheduleSource}</code>
                    </p>
                  {/if}
                  {#if task.operations?.length}
                    <ul class="mt-2 space-y-1" aria-label={`${task.name} operations`}>
                      {#each task.operations as operation (operation.id)}
                        <li class="text-[11px] text-shadow-600">
                          <code class="font-mono text-shadow-700">{operation.name}</code>
                          <span class="block text-shadow-500">{operation.description}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </td>
                <td class="px-4 py-3">
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {TYPE_BADGE[task.type] || 'bg-bark-200 text-shadow-600'}">
                    {task.type}
                  </span>
                </td>
                <td class="px-4 py-3">
                  {#if task.type === 'every'}
                    {#if task.scheduleSource}
                      <div class="space-y-1">
                        <span class="text-sm text-shadow-700 font-mono">{formatInterval(task)}</span>
                        <span class="block text-[11px] text-shadow-500">Edit this shared cadence in Settings.</span>
                      </div>
                    {:else if hasCadenceControls(task)}
                      {@const cadenceEditor = getCadenceEditor(task)}
                      <div class="space-y-2">
                        <div class="flex flex-wrap items-center gap-2">
                          <select
                            value={cadenceEditor.mode}
                            onchange={(e) => {
                              updateCadenceEditor(task, { mode: (e.target as HTMLSelectElement).value as CadenceEditorMode });
                            }}
                            class="garden-field min-h-11 px-2 py-1 text-xs border border-bark-300 rounded
                                   bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                          >
                            <option value="relative">Interval</option>
                            <option value="hourly">Hourly on minute</option>
                            <option value="daily">Daily at time</option>
                            <option value="weekly">Weekly at time</option>
                          </select>
                          <span class="text-[11px] text-shadow-500">
                            {cadenceEditor.mode === 'relative' ? 'Relative cadence' : 'Clock-aware cadence'}
                          </span>
                        </div>

                        {#if cadenceEditor.mode === 'relative'}
                          <div class="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={editingIntervals[task.id] ?? msToHuman(task.intervalMs)}
                              oninput={(e) => { editingIntervals[task.id] = (e.target as HTMLInputElement).value; }}
                              class="garden-field min-h-11 w-24 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <button
                              onclick={() => saveTaskCadence(task)}
                              disabled={saving === `cadence:${task.id}`}
                              class="garden-action garden-action--primary min-h-11 text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                                     text-moss-700 hover:bg-moss-100 transition-colors
                                     disabled:opacity-50 font-medium"
                            >
                              {saving === `cadence:${task.id}` ? '...' : 'Save'}
                            </button>
                          </div>
                        {:else if cadenceEditor.mode === 'hourly'}
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-shadow-600">Minute</span>
                            <input
                              type="number"
                              min="0"
                              max="59"
                              value={cadenceEditor.minute}
                              oninput={(e) => {
                                updateCadenceEditor(task, { minute: (e.target as HTMLInputElement).value });
                              }}
                              class="garden-field min-h-11 w-16 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <select
                              value={cadenceEditor.timezone}
                              onchange={(e) => {
                                updateCadenceEditor(task, { timezone: (e.target as HTMLSelectElement).value as SchedulerCadenceTimezone });
                              }}
                              class="garden-field min-h-11 px-2 py-1 text-xs border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            >
                              <option value="local">Local</option>
                              <option value="utc">UTC</option>
                            </select>
                            <button
                              onclick={() => saveTaskCadence(task)}
                              disabled={saving === `cadence:${task.id}`}
                              class="garden-action garden-action--primary min-h-11 text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                                     text-moss-700 hover:bg-moss-100 transition-colors
                                     disabled:opacity-50 font-medium"
                            >
                              {saving === `cadence:${task.id}` ? '...' : 'Save'}
                            </button>
                          </div>
                        {:else if cadenceEditor.mode === 'daily'}
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-shadow-600">Time</span>
                            <input
                              type="number"
                              min="0"
                              max="23"
                              value={cadenceEditor.hour}
                              oninput={(e) => {
                                updateCadenceEditor(task, { hour: (e.target as HTMLInputElement).value });
                              }}
                              class="garden-field min-h-11 w-14 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <span class="text-xs text-shadow-500">:</span>
                            <input
                              type="number"
                              min="0"
                              max="59"
                              value={cadenceEditor.minute}
                              oninput={(e) => {
                                updateCadenceEditor(task, { minute: (e.target as HTMLInputElement).value });
                              }}
                              class="garden-field min-h-11 w-14 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <select
                              value={cadenceEditor.timezone}
                              onchange={(e) => {
                                updateCadenceEditor(task, { timezone: (e.target as HTMLSelectElement).value as SchedulerCadenceTimezone });
                              }}
                              class="garden-field min-h-11 px-2 py-1 text-xs border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            >
                              <option value="local">Local</option>
                              <option value="utc">UTC</option>
                            </select>
                            <button
                              onclick={() => saveTaskCadence(task)}
                              disabled={saving === `cadence:${task.id}`}
                              class="garden-action garden-action--primary min-h-11 text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                                     text-moss-700 hover:bg-moss-100 transition-colors
                                     disabled:opacity-50 font-medium"
                            >
                              {saving === `cadence:${task.id}` ? '...' : 'Save'}
                            </button>
                          </div>
                        {:else}
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-shadow-600">Day</span>
                            <select
                              value={cadenceEditor.dayOfWeek}
                              onchange={(e) => {
                                updateCadenceEditor(task, { dayOfWeek: (e.target as HTMLSelectElement).value });
                              }}
                              class="garden-field min-h-11 px-2 py-1 text-xs border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            >
                              {#each WEEKDAY_LABELS as label, index}
                                <option value={String(index)}>{label}</option>
                              {/each}
                            </select>
                            <span class="text-xs text-shadow-600">Time</span>
                            <input
                              type="number"
                              min="0"
                              max="23"
                              value={cadenceEditor.hour}
                              oninput={(e) => {
                                updateCadenceEditor(task, { hour: (e.target as HTMLInputElement).value });
                              }}
                              class="garden-field min-h-11 w-14 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <span class="text-xs text-shadow-500">:</span>
                            <input
                              type="number"
                              min="0"
                              max="59"
                              value={cadenceEditor.minute}
                              oninput={(e) => {
                                updateCadenceEditor(task, { minute: (e.target as HTMLInputElement).value });
                              }}
                              class="garden-field min-h-11 w-14 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            />
                            <select
                              value={cadenceEditor.timezone}
                              onchange={(e) => {
                                updateCadenceEditor(task, { timezone: (e.target as HTMLSelectElement).value as SchedulerCadenceTimezone });
                              }}
                              class="garden-field min-h-11 px-2 py-1 text-xs border border-bark-300 rounded
                                     bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                            >
                              <option value="local">Local</option>
                              <option value="utc">UTC</option>
                            </select>
                            <button
                              onclick={() => saveTaskCadence(task)}
                              disabled={saving === `cadence:${task.id}`}
                              class="garden-action garden-action--primary min-h-11 text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                                     text-moss-700 hover:bg-moss-100 transition-colors
                                     disabled:opacity-50 font-medium"
                            >
                              {saving === `cadence:${task.id}` ? '...' : 'Save'}
                            </button>
                          </div>
                        {/if}
                      </div>
                    {:else}
                      <div class="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingIntervals[task.id] ?? msToHuman(task.intervalMs)}
                          oninput={(e) => { editingIntervals[task.id] = (e.target as HTMLInputElement).value; }}
                          class="garden-field min-h-11 w-24 px-2 py-1 text-sm font-mono border border-bark-300 rounded
                                 bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400"
                        />
                        <button
                          onclick={() => saveTaskInterval(task)}
                          disabled={saving === `interval:${task.id}`}
                          class="garden-action garden-action--primary min-h-11 text-xs px-2 py-1 rounded border border-moss-300 bg-moss-50
                                 text-moss-700 hover:bg-moss-100 transition-colors
                                 disabled:opacity-50 font-medium"
                        >
                          {saving === `interval:${task.id}` ? '...' : 'Save'}
                        </button>
                      </div>
                    {/if}
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
                    {#if task.scheduleSource}
                      <span class="text-xs text-shadow-500">Read-only · restart after Settings edits</span>
                    {:else if task.type === 'every'}
                      <button
                        onclick={() => toggleTaskEnabled(task)}
                        disabled={saving === `toggle:${task.id}`}
                        class="garden-action min-h-11 text-xs px-2 py-1 rounded border transition-colors font-medium disabled:opacity-50
                               {task.state === 'paused'
                                 ? 'border-moss-300 bg-moss-50 text-moss-700 hover:bg-moss-100'
                                 : 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100'}"
                      >
                        {task.state === 'paused' ? 'Enable' : 'Pause'}
                      </button>
                    {/if}
                    {#if !task.scheduleSource && !isProtected(task.id)}
                      <button
                        onclick={() => handleRemoveTask(task)}
                        disabled={saving === `remove:${task.id}`}
                        class="garden-action garden-action--danger min-h-11 text-xs px-2 py-1 rounded border border-wilt-300 bg-wilt-50
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
      <div class="garden-section card-garden overflow-hidden">
        <div class="garden-section-header px-4 py-3 border-b border-bark-200 bg-bark-50">
          <h2 class="font-serif font-semibold text-shadow-800">Reflection Templates</h2>
          <p class="text-xs text-shadow-600 mt-0.5">Reflection templates. Edit prompts. Scheduling is managed in Scheduled Tasks.</p>
        </div>

        <div class="divide-y divide-bark-100">
          {#each reflections as tpl (tpl.id)}
            <div class="px-4 py-4">
              <!-- Template header -->
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3 min-w-0">
                  <button
                    onclick={() => toggleReflectionExpanded(tpl.id)}
                    class="garden-action min-h-11 min-w-11 text-shadow-500 hover:text-shadow-700 transition-colors shrink-0"
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
                      <span
                        class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
                               {isReflectionEnabled(tpl)
                                 ? 'bg-moss-100 text-moss-700'
                                 : 'bg-wilt-100 text-wilt-700'}"
                      >
                        <span
                          class="w-1.5 h-1.5 rounded-full
                                 {isReflectionEnabled(tpl) ? 'bg-moss-500' : 'bg-wilt-500'}"
                        ></span>
                        {isReflectionEnabled(tpl) ? 'enabled' : 'disabled'}
                      </span>
                      {#if tpl.mode === 'deliberation'}
                        <span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-petal-100 text-petal-600">deliberation</span>
                      {/if}
                    </div>
                    <p class="text-xs text-shadow-600 mt-0.5 truncate">{tpl.prompt.slice(0, 80)}{tpl.prompt.length > 80 ? '...' : ''}</p>
                    <p class="text-[11px] text-shadow-500 mt-1">
                      Status: {isReflectionEnabled(tpl) ? 'Enabled' : 'Disabled'} · Schedule: {getReflectionScheduleLabel(tpl)}
                    </p>
                  </div>
                </div>

                <div class="flex items-center gap-3 shrink-0">
                  <button
                    onclick={() => toggleReflectionEnabled(tpl)}
                    disabled={saving === `reflection-enabled:${tpl.id}`}
                    class="garden-action min-h-11 flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors font-medium disabled:opacity-50
                           {isReflectionEnabled(tpl)
                             ? 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100'
                             : 'border-moss-300 bg-moss-50 text-moss-700 hover:bg-moss-100'}"
                    title={isReflectionEnabled(tpl) ? 'Disable reflection template' : 'Enable reflection template'}
                  >
                    {isReflectionEnabled(tpl) ? 'Disable' : 'Enable'}
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
                           bg-bark-50 text-shadow-800 focus:outline-none focus:ring-1 focus:ring-gold-400
                           resize-y font-sans"
                  ></textarea>
                  <div class="flex items-center justify-between mt-2">
                    <span class="text-xs text-shadow-500">{(editingPrompts[tpl.id] ?? '').length} chars</span>
                    <button
                      onclick={() => saveReflectionPrompt(tpl)}
                      disabled={saving === `reflection-prompt:${tpl.id}` || editingPrompts[tpl.id] === tpl.prompt}
                      class="garden-action garden-action--primary min-h-11 text-xs px-3 py-1.5 rounded-lg bg-moss-600 text-white
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
