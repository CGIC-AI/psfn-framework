<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listConcerns,
    resolveConcern,
    suppressConcern,
    transitionConcern,
    resolveStaleConcerns,
    type ConcernView,
  } from '$lib/api/endpoints/concerns';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import ConcernActionEscalationModal from '$lib/components/ConcernActionEscalationModal.svelte';
  import { pushToast } from '$lib/stores/toast.svelte';

  const TRANSITION_STATUSES = ['candidate', 'active', 'watching', 'deferred', 'blocked'] as const;

  let concerns = $state<ConcernView[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let includeResolved = $state(false);
  let actionBusyId = $state('');
  let outcomeDrafts = $state<Record<string, string>>({});
  let escalationReason = $state('');

  interface PendingConcernAction {
    key: string;
    title: string;
    context: string;
    done: string;
    run: (reason: string) => Promise<{ ok: boolean; message?: string }>;
  }

  let pendingAction = $state<PendingConcernAction | null>(null);

  const PRIORITY_BADGE: Record<string, string> = {
    high: 'bg-wilt-50 text-wilt-700 border-wilt-300',
    medium: 'bg-gold-50 text-gold-700 border-gold-300',
    low: 'bg-bark-100 text-shadow-600 border-bark-300',
  };

  const STATUS_BADGE: Record<string, string> = {
    candidate: 'bg-bark-100 text-shadow-600 border-bark-300',
    active: 'bg-wilt-50 text-wilt-700 border-wilt-300',
    watching: 'bg-gold-50 text-gold-700 border-gold-300',
    deferred: 'bg-bark-100 text-shadow-600 border-bark-300',
    blocked: 'bg-wilt-100 text-wilt-800 border-wilt-400',
    resolved: 'bg-moss-50 text-moss-700 border-moss-300',
    dismissed: 'bg-bark-100 text-shadow-500 border-bark-300',
    suppressed: 'bg-bark-100 text-shadow-500 border-bark-300',
  };

  function priorityBadge(priority: string): string {
    return PRIORITY_BADGE[priority] ?? PRIORITY_BADGE.low;
  }

  function statusBadge(status: string): string {
    return STATUS_BADGE[status] ?? STATUS_BADGE.candidate;
  }

  function formatWhen(value: string | undefined): string {
    if (!value) return '—';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleString();
  }

  async function load() {
    error = '';
    try {
      const payload = await listConcerns({ includeResolved, limit: 100 });
      concerns = payload.concerns;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load concerns';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refresh() {
    refreshing = true;
    await load();
  }

  async function runAction(
    id: string,
    action: () => Promise<{ ok: boolean; message?: string }>,
    done: string,
  ): Promise<boolean> {
    actionBusyId = id;
    try {
      const result = await action();
      if (result.ok) {
        pushToast(done, 'success');
        await load();
        return true;
      } else {
        pushToast(result.message || 'Concern action failed', 'error');
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Concern action failed', 'error');
    } finally {
      actionBusyId = '';
    }
    return false;
  }

  function requestAction(action: PendingConcernAction): void {
    escalationReason = '';
    pendingAction = action;
  }

  async function confirmAction(): Promise<void> {
    const action = pendingAction;
    if (!action) return;
    const reason = escalationReason.trim();
    if (!reason) {
      pushToast('State an audited reason before changing a concern', 'error');
      return;
    }
    if (await runAction(action.key, () => action.run(reason), action.done)) {
      escalationReason = '';
      pendingAction = null;
    }
  }

  function cancelAction(): void {
    if (actionBusyId) return;
    escalationReason = '';
    pendingAction = null;
  }

  function draft(id: string): string {
    return outcomeDrafts[id] ?? '';
  }

  function setDraft(id: string, value: string): void {
    outcomeDrafts = { ...outcomeDrafts, [id]: value };
  }

  onMount(() => {
    void load();
  });
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-3">
    <div class="min-w-0">
      <p class="text-[0.65rem] uppercase tracking-[0.2em] text-shadow-500">Intention</p>
      <h1 class="flex items-baseline gap-2 text-xl font-serif font-bold text-shadow-900">
        Concerns
        <span class="text-sm font-sans font-normal text-shadow-600">
          {concerns.length} shown
        </span>
      </h1>
    </div>
    <div class="flex min-w-0 flex-1 items-center justify-end gap-2">
      <label class="flex items-center gap-2 text-sm text-shadow-700">
        <input
          type="checkbox"
          bind:checked={includeResolved}
          onchange={() => void load()}
          class="h-4 w-4 rounded border-bark-300"
        />
        Include resolved / terminal
      </label>
      <button
        type="button"
        onclick={() => requestAction({
          key: '__stale__',
          title: 'Resolve all stale concerns?',
          context: 'Exact action: resolve stale concern projections',
          done: 'Stale concerns resolved',
          run: (reason) => resolveStaleConcerns(reason),
        })}
        disabled={actionBusyId !== '' || pendingAction !== null}
        class="rounded-xl border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
      >
        Resolve stale
      </button>
      <button
        type="button"
        onclick={refresh}
        disabled={refreshing}
        class="rounded-xl border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  </div>

  <section class="card-garden border-l-4 border-l-gold-400 p-4" aria-labelledby="concern-escalation-title">
    <h2 id="concern-escalation-title" class="font-serif font-semibold text-shadow-900">
      Protected concern actions
    </h2>
    <p class="mt-1 text-sm text-shadow-700">
      Click an action to provide its mandatory justification. One submission mints and spends
      a single-use grant for that exact target, then records a content-free notice for the companion.
    </p>
  </section>

  {#if error}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden animate-pulse p-5">
      <div class="h-4 w-2/3 rounded bg-bark-200"></div>
      <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
      <div class="mt-2 h-3 w-5/6 rounded bg-bark-100"></div>
    </div>
  {:else if concerns.length === 0}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-600">No concerns match the current filter.</p>
    </div>
  {:else}
    <BoundedList maxHeight="36rem" label="Concerns">
      <ul class="space-y-3 pr-1">
        {#each concerns as concern (concern.id)}
          {@const terminal = ['resolved', 'dismissed', 'suppressed'].includes(concern.status)}
          <li class="rounded-xl border border-bark-200 bg-bark-50 p-4">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-shadow-900">{concern.text}</p>
                <p class="mt-1 text-xs text-shadow-500">
                  {concern.source} · salience {(concern.salience * 100).toFixed(0)}% · since {formatWhen(concern.createdAt)}
                  {#if concern.nextReviewAt}
                    · review {formatWhen(concern.nextReviewAt)}
                  {/if}
                  {#if concern.outcome}
                    · outcome: {concern.outcome}
                  {/if}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <span class="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium {priorityBadge(concern.priority)}">
                  {concern.priority}
                </span>
                <span class="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium {statusBadge(concern.status)}">
                  {concern.status}
                </span>
              </div>
            </div>

            {#if !terminal}
              <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-bark-200 pt-3">
                <input
                  type="text"
                  value={draft(concern.id)}
                  oninput={(event) => setDraft(concern.id, (event.currentTarget as HTMLInputElement).value)}
                  placeholder="Outcome note (optional)"
                  aria-label="Outcome note"
                  class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-white px-2.5 py-1.5 text-sm text-shadow-900"
                />
                <select
                  aria-label="Transition status"
                  disabled={actionBusyId !== '' || pendingAction !== null}
                  onchange={(event) => {
                    const status = (event.currentTarget as HTMLSelectElement).value;
                    if (!status) return;
                    (event.currentTarget as HTMLSelectElement).value = '';
                    requestAction({
                      key: concern.id,
                      title: `Move concern to ${status}?`,
                      context: `Exact concern: ${concern.id}. Exact transition: ${status}.`,
                      done: 'Concern transitioned',
                      run: (reason) => transitionConcern(
                        concern.id,
                        status,
                        reason,
                        { outcome: draft(concern.id) || undefined },
                      ),
                    });
                  }}
                  class="rounded-lg border border-bark-300 bg-white px-2.5 py-1.5 text-sm text-shadow-700 disabled:opacity-50"
                >
                  <option value="">Move to…</option>
                  {#each TRANSITION_STATUSES as status}
                    {#if status !== concern.status}
                      <option value={status}>{status}</option>
                    {/if}
                  {/each}
                </select>
                <button
                  type="button"
                  disabled={actionBusyId !== '' || pendingAction !== null}
                  onclick={() => requestAction({
                    key: concern.id,
                    title: 'Resolve this concern?',
                    context: `Exact concern: ${concern.id}. Exact action: resolve.`,
                    done: 'Concern resolved',
                    run: (reason) => resolveConcern(concern.id, reason, draft(concern.id) || undefined),
                  })}
                  class="rounded-lg border border-moss-300 bg-moss-50 px-3 py-1.5 text-sm font-medium text-moss-800 transition-colors hover:bg-moss-100 disabled:opacity-50"
                >
                  Resolve
                </button>
                <button
                  type="button"
                  disabled={actionBusyId !== '' || pendingAction !== null}
                  onclick={() => requestAction({
                    key: concern.id,
                    title: 'Suppress this concern?',
                    context: `Exact concern: ${concern.id}. Exact action: suppress.`,
                    done: 'Concern suppressed',
                    run: (reason) => suppressConcern(concern.id, reason, draft(concern.id) || undefined),
                  })}
                  class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
                >
                  Suppress
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </BoundedList>
  {/if}
</div>

<ConcernActionEscalationModal
  open={pendingAction !== null}
  title={pendingAction?.title ?? 'Confirm concern action?'}
  context={pendingAction?.context ?? ''}
  reason={escalationReason}
  busy={actionBusyId !== ''}
  onReasonChange={(reason) => { escalationReason = reason; }}
  onConfirm={() => void confirmAction()}
  onCancel={cancelAction}
/>
