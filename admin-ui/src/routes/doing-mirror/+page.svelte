<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    listDoingMirrorItems,
    transitionDoingMirrorItem,
    type DoingMirrorItem,
    type DoingMirrorTransitionInput,
  } from '$lib/api/endpoints/doing-mirror';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import { pushToast } from '$lib/stores/toast.svelte';

  type TargetState = DoingMirrorTransitionInput['state'];

  let items = $state<DoingMirrorItem[]>([]);
  let boundary = $state('');
  let loading = $state(true);
  let errorMessage = $state('');
  let busyKey = $state('');
  let composingKey = $state('');
  let targetState = $state<TargetState>('considering');
  let reason = $state('');
  let subject = $state('');
  let body = $state('');

  function key(item: DoingMirrorItem): string {
    return `${item.source.itemType}:${item.source.itemId}`;
  }

  function formatDate(value: number): string {
    return new Date(value).toLocaleString();
  }

  function itemTypeLabel(item: DoingMirrorItem): string {
    return item.source.itemType === 'wishlist' ? 'Wishlist' : 'Fold package';
  }

  function stateClasses(state: DoingMirrorItem['disposition']['state']): string {
    if (state === 'open') return 'border-gold-300 bg-gold-50 text-gold-700';
    if (state === 'considering') return 'border-moss-300 bg-moss-50 text-moss-700';
    if (state === 'done') return 'border-bark-300 bg-bark-50 text-shadow-600';
    return 'border-wilt-300 bg-wilt-50 text-wilt-700';
  }

  async function load(background = false): Promise<void> {
    if (!background) loading = true;
    try {
      const data = await listDoingMirrorItems();
      items = data.items;
      boundary = data.boundary;
      errorMessage = '';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load the doing mirror.';
    } finally {
      loading = false;
    }
  }

  function begin(item: DoingMirrorItem, state: TargetState): void {
    composingKey = key(item);
    targetState = state;
    reason = '';
    subject = '';
    body = '';
  }

  function cancel(): void {
    composingKey = '';
    reason = '';
    subject = '';
    body = '';
  }

  async function submit(item: DoingMirrorItem): Promise<void> {
    if (!subject.trim() || !body.trim()) {
      pushToast('Write the Letter subject and body in your own words.', 'error');
      return;
    }
    if (targetState === 'declined' && !reason.trim()) {
      pushToast('A decline requires a companion-visible reason.', 'error');
      return;
    }
    busyKey = key(item);
    try {
      await transitionDoingMirrorItem({
        itemType: item.source.itemType,
        itemId: item.source.itemId,
        state: targetState,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        subject,
        body,
      });
      pushToast('Disposition saved and Letter placed in the companion bin.', 'success');
      cancel();
      await load(true);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Disposition could not be saved.', 'error');
    } finally {
      busyKey = '';
    }
  }

  const poller = createVisibilityAwarePoller({ refresh: () => load(true), intervalMs: 30_000 });
  onMount(() => poller.start());
  onDestroy(() => poller.stop());
</script>

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="Doing mirror"
    description="Return the fate of companion-originated work without taking authorship or changing who decides."
  />

  {#if boundary}<p class="rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-shadow-600">{boundary}</p>{/if}
  {#if errorMessage}<div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4 text-sm text-wilt-700">{errorMessage}</div>{/if}

  {#if loading}
    <p class="text-sm text-shadow-500">Opening the mirror…</p>
  {:else if items.length === 0}
    <div class="card-garden p-8 text-center text-sm text-shadow-500">No supported companion-originated items are waiting.</div>
  {:else}
    <section class="space-y-3" aria-label="Companion-originated item dispositions">
      {#each items as item (key(item))}
        <article class="card-garden p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">{itemTypeLabel(item)}</p>
              <h2 class="mt-1 font-serif text-lg text-shadow-900">{item.source.title}</h2>
              <p class="mt-1 font-mono text-xs text-shadow-500">{item.source.ref}</p>
            </div>
            <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${stateClasses(item.disposition.state)}`}>
              {item.disposition.state}
            </span>
          </div>
          {#if item.source.summary}<p class="mt-3 whitespace-pre-wrap text-sm text-shadow-700">{item.source.summary}</p>{/if}
          {#if 'reason' in item.disposition && item.disposition.reason}
            <div class="mt-3 rounded-xl border border-bark-200 bg-bark-50 px-4 py-3">
              <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Visible reason</p>
              <p class="mt-1 whitespace-pre-wrap text-sm text-shadow-800">{item.disposition.reason}</p>
            </div>
          {/if}
          <p class="mt-3 text-xs text-shadow-500">Disposition updated {formatDate(item.disposition.updatedAt)}</p>

          {#if composingKey === key(item)}
            <div class="mt-4 space-y-3 border-t border-bark-100 pt-4">
              <p class="text-sm font-semibold text-shadow-800">Record {targetState} and author its Letter</p>
              <input bind:value={reason} placeholder={targetState === 'declined' ? 'Reason (required)' : 'Reason (optional)'} class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm outline-none focus:border-gold-400" />
              <input bind:value={subject} placeholder="Letter subject — your words" class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm outline-none focus:border-gold-400" />
              <textarea bind:value={body} rows="4" placeholder="Letter body — your words, delivered exactly" class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm outline-none focus:border-gold-400"></textarea>
              <div class="flex gap-2">
                <button type="button" onclick={() => void submit(item)} disabled={busyKey === key(item)} class="rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save and place Letter</button>
                <button type="button" onclick={cancel} disabled={busyKey === key(item)} class="rounded-lg border border-bark-300 px-4 py-2 text-sm text-shadow-700 disabled:opacity-50">Cancel</button>
              </div>
            </div>
          {:else if item.disposition.state === 'open'}
            <button type="button" onclick={() => begin(item, 'considering')} class="mt-4 rounded-lg border border-moss-300 bg-moss-50 px-3 py-1.5 text-sm font-medium text-moss-700">Begin considering</button>
          {:else if item.disposition.state === 'considering'}
            <div class="mt-4 flex gap-2">
              <button type="button" onclick={() => begin(item, 'done')} class="rounded-lg border border-moss-300 bg-moss-50 px-3 py-1.5 text-sm font-medium text-moss-700">Mark done</button>
              <button type="button" onclick={() => begin(item, 'declined')} class="rounded-lg border border-wilt-300 bg-wilt-50 px-3 py-1.5 text-sm font-medium text-wilt-700">Decline</button>
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
</div>
