<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    acknowledgeWish,
    completeWish,
    convertWishToBead,
    listWishes,
    MAX_OPERATOR_RESPONSE_CHARS,
    respondToWish,
    type CompanionWish,
    type CompanionWishState,
  } from '$lib/api/endpoints/wishlist';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import { pushToast } from '$lib/stores/toast.svelte';
  import {
    activeWishes,
    countWishesByState,
    wishlistStateLabel,
    WISHLIST_STATE_ORDER,
  } from '$lib/wishlist/view';

  let wishes = $state<CompanionWish[]>([]);
  let boundary = $state('');
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let busyId = $state('');
  let showCompleted = $state(false);
  let responses = $state<Record<string, string>>({});

  let counts = $derived(countWishesByState(wishes));
  let visibleWishes = $derived(showCompleted ? wishes : activeWishes(wishes));

  function formatDate(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  function stateClasses(state: CompanionWishState): string {
    switch (state) {
      case 'open': return 'border-gold-300 bg-gold-100 text-gold-700';
      case 'acknowledged': return 'border-moss-300 bg-moss-100 text-moss-700';
      case 'planned': return 'border-bark-300 bg-bark-100 text-shadow-700';
      case 'done': return 'border-bark-200 bg-bark-50 text-shadow-500';
    }
  }

  async function loadWishes(background = false): Promise<void> {
    if (!background) refreshing = true;
    errorMessage = '';
    try {
      const data = await listWishes();
      wishes = data.wishes;
      boundary = data.boundary;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load the wishlist.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function mutateWish(
    wish: CompanionWish,
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<void> {
    busyId = wish.id;
    try {
      await action();
      pushToast(successMessage, 'success');
      await loadWishes(true);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Wishlist action failed.', 'error');
    } finally {
      busyId = '';
    }
  }

  async function handleResponse(wish: CompanionWish): Promise<void> {
    const response = responses[wish.id]?.trim() ?? '';
    if (!response) {
      pushToast('Write a response before sending it.', 'error');
      return;
    }
    await mutateWish(
      wish,
      () => respondToWish(wish.id, response),
      'Response saved for the companion.',
    );
    responses[wish.id] = '';
  }

  const poller = createVisibilityAwarePoller({
    refresh: () => loadWishes(true),
    intervalMs: 30_000,
  });

  onMount(() => poller.start());
  onDestroy(() => poller.stop());
</script>

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="Wishlist"
    description="A low-pressure queue for things the companion wants, saved without interruption."
  >
    {#snippet actions()}
      <label class="flex items-center gap-2 text-sm text-shadow-600">
        <input type="checkbox" bind:checked={showCompleted} class="accent-moss-600" />
        Show done
      </label>
      <button
        type="button"
        onclick={() => void loadWishes()}
        disabled={refreshing}
        class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50"
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    {/snippet}
  </GardenPageHeader>

  {#if boundary}
    <p class="rounded-xl border border-bark-200 bg-bark-50 px-4 py-3 text-sm text-shadow-600">{boundary}</p>
  {/if}

  <section class="garden-metric-grid grid-cols-2 lg:grid-cols-4" aria-label="Wishlist state summary">
    {#each WISHLIST_STATE_ORDER as state}
      <div class="garden-metric card-garden px-4 py-3">
        <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">{wishlistStateLabel(state)}</p>
        <p class="mt-1 text-xl font-semibold text-shadow-900">{counts[state]}</p>
      </div>
    {/each}
  </section>

  {#if errorMessage}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4 text-sm text-wilt-700">{errorMessage}</div>
  {/if}

  {#if loading}
    <p class="garden-loading px-1 text-sm text-shadow-600">Loading wishes...</p>
  {:else if visibleWishes.length === 0}
    <div class="garden-empty card-garden p-10 text-center">
      <p class="font-serif text-lg text-shadow-800">{showCompleted ? 'No wishes yet' : 'No active wishes'}</p>
      <p class="mt-1 text-sm text-shadow-600">New wishes will appear here after she saves them through her canonical wiki tool.</p>
    </div>
  {:else}
    <BoundedList maxHeight="46rem" label="Companion wishlist">
      <div class="space-y-4 pr-1">
        {#each visibleWishes as wish (wish.id)}
          <article class="garden-section card-garden overflow-hidden">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-bark-100 bg-bark-50 px-5 py-4">
              <div class="min-w-0 flex-1">
                <p class="text-base font-semibold text-shadow-900">{wish.text}</p>
                <p class="mt-1 font-mono text-xs text-shadow-500">{wish.ref}</p>
              </div>
              <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${stateClasses(wish.state)}`}>
                {wishlistStateLabel(wish.state)}
              </span>
            </div>

            <div class="space-y-4 px-5 py-4">
              {#if wish.context}
                <div>
                  <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Context</p>
                  <p class="mt-1 whitespace-pre-wrap text-sm text-shadow-700">{wish.context}</p>
                </div>
              {/if}
              {#if wish.operatorResponse}
                <div class="rounded-xl border border-moss-200 bg-moss-50 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.14em] text-moss-700">Your response</p>
                  <p class="mt-1 whitespace-pre-wrap text-sm text-shadow-800">{wish.operatorResponse}</p>
                </div>
              {/if}
              {#if wish.beadId}
                <p class="text-sm text-shadow-700">Planned as <code class="rounded bg-bark-100 px-1.5 py-0.5">{wish.beadId}</code></p>
              {/if}

              <p class="text-xs text-shadow-500">
                Saved {formatDate(wish.createdAt)} · updated {formatDate(wish.updatedAt)}
              </p>

              {#if wish.state !== 'done'}
                <div class="space-y-3 border-t border-bark-100 pt-4">
                  <label class="block">
                    <span class="text-xs uppercase tracking-[0.14em] text-shadow-500">Reply without changing her words</span>
                    <textarea
                      bind:value={responses[wish.id]}
                      rows="2"
                      maxlength={MAX_OPERATOR_RESPONSE_CHARS}
                      placeholder="Acknowledge the wish, share a thought, or suggest a next step"
                      class="mt-1.5 w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 outline-none focus:border-gold-400"
                    ></textarea>
                  </label>
                  <div class="flex flex-wrap gap-2">
                    {#if wish.state === 'open'}
                      <button
                        type="button"
                        onclick={() => void mutateWish(wish, () => acknowledgeWish(wish.id), 'Wish acknowledged.')}
                        disabled={busyId === wish.id}
                        class="rounded-lg border border-moss-300 bg-moss-100 px-3 py-1.5 text-sm font-medium text-moss-700 hover:bg-moss-200 disabled:opacity-50"
                      >Acknowledge</button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => void handleResponse(wish)}
                      disabled={busyId === wish.id}
                      class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50"
                    >Respond</button>
                    {#if wish.state !== 'planned'}
                      <button
                        type="button"
                        onclick={() => void mutateWish(wish, () => convertWishToBead(wish.id), 'Wish converted to a tracked bead.')}
                        disabled={busyId === wish.id}
                        class="rounded-lg border border-gold-300 bg-gold-100 px-3 py-1.5 text-sm font-medium text-gold-700 hover:bg-gold-200 disabled:opacity-50"
                      >Convert to bead</button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => void mutateWish(wish, () => completeWish(wish.id), 'Wish marked done.')}
                      disabled={busyId === wish.id}
                      class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-600 hover:bg-bark-100 disabled:opacity-50"
                    >Mark done</button>
                  </div>
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </BoundedList>
  {/if}
</div>
