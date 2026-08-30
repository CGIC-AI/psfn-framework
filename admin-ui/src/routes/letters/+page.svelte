<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    archiveLetter,
    composeLetter,
    listLetters,
    placeLetter,
    readLetter,
    type LetterRecord,
  } from '$lib/api/endpoints/letters';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import { pushToast } from '$lib/stores/toast.svelte';

  let letters = $state<LetterRecord[]>([]);
  let waitingCount = $state(0);
  let boundary = $state('');
  let subject = $state('');
  let body = $state('');
  let loading = $state(true);
  let busy = $state('');
  let errorMessage = $state('');

  async function load(background = false): Promise<void> {
    if (!background) loading = true;
    try {
      const data = await listLetters();
      letters = data.letters;
      waitingCount = data.waitingCount;
      boundary = data.boundary;
      errorMessage = '';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load letters.';
    } finally {
      loading = false;
    }
  }

  async function compose(draft = false): Promise<void> {
    if (!subject.trim() || !body.trim()) {
      pushToast('A subject and letter body are required.', 'error');
      return;
    }
    busy = 'compose';
    try {
      await composeLetter({ subject, body, ...(draft ? { draft: true } : {}) });
      subject = '';
      body = '';
      pushToast(draft ? 'Draft saved.' : 'Letter placed quietly in the bin.', 'success');
      await load(true);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Letter could not be saved.', 'error');
    } finally {
      busy = '';
    }
  }

  async function transition(letter: LetterRecord, action: 'place' | 'read' | 'archive'): Promise<void> {
    busy = letter.id;
    try {
      if (action === 'place') await placeLetter(letter.id);
      else if (action === 'read') await readLetter(letter.id);
      else await archiveLetter(letter.id);
      await load(true);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Letter state could not be changed.', 'error');
    } finally {
      busy = '';
    }
  }

  const poller = createVisibilityAwarePoller({ refresh: () => load(true), intervalMs: 30_000 });
  onMount(() => poller.start());
  onDestroy(() => poller.stop());
</script>

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="Letters"
    description="Private correspondence that waits until the other person chooses to visit."
  />

  {#if boundary}<p class="rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-shadow-600">{boundary}</p>{/if}
  {#if errorMessage}<div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4 text-sm text-wilt-700">{errorMessage}</div>{/if}

  <section class="card-garden space-y-3 p-5" aria-label="Compose a letter">
    <div class="flex items-baseline justify-between gap-3">
      <h2 class="font-serif text-lg text-shadow-900">Leave a letter</h2>
      <span class="text-xs text-shadow-500">No notification will be sent</span>
    </div>
    <input bind:value={subject} placeholder="Subject" class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm outline-none focus:border-gold-400" />
    <textarea bind:value={body} rows="6" placeholder="Write for whenever they arrive…" class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm outline-none focus:border-gold-400"></textarea>
    <div class="flex flex-wrap gap-2">
      <button type="button" onclick={() => void compose(false)} disabled={busy === 'compose'} class="rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Place in bin</button>
      <button type="button" onclick={() => void compose(true)} disabled={busy === 'compose'} class="rounded-lg border border-bark-300 px-4 py-2 text-sm text-shadow-700 disabled:opacity-50">Save draft</button>
    </div>
  </section>

  <section class="space-y-3" aria-label="Letters bin">
    <div class="flex items-center justify-between">
      <h2 class="font-serif text-lg text-shadow-900">The bin</h2>
      {#if waitingCount > 0}<span class="rounded-full border border-gold-300 bg-gold-50 px-2.5 py-1 text-xs text-gold-700">{waitingCount} waiting</span>{/if}
    </div>
    {#if loading}
      <p class="text-sm text-shadow-500">Opening the bin…</p>
    {:else if letters.length === 0}
      <div class="card-garden p-8 text-center text-sm text-shadow-500">The bin is empty.</div>
    {:else}
      <div class="space-y-3">
        {#each letters as letter (letter.id)}
          <article class="card-garden p-5 {letter.state === 'placed' && letter.recipient === 'partner' ? 'border-gold-300' : ''}">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">{letter.author === 'partner' ? 'From you' : 'From Companion'}</p>
                <h3 class="mt-1 font-serif text-lg text-shadow-900">{letter.subject}</h3>
              </div>
              <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-1 text-xs text-shadow-600">{letter.state}</span>
            </div>
            <p class="mt-4 whitespace-pre-wrap text-sm leading-6 text-shadow-700">{letter.body}</p>
            <div class="mt-4 flex gap-2 border-t border-bark-100 pt-3">
              {#if letter.state === 'draft' && letter.author === 'partner'}
                <button type="button" onclick={() => void transition(letter, 'place')} disabled={busy === letter.id} class="text-sm font-medium text-gold-700">Place in bin</button>
              {:else if letter.state === 'placed' && letter.recipient === 'partner'}
                <button type="button" onclick={() => void transition(letter, 'read')} disabled={busy === letter.id} class="text-sm font-medium text-gold-700">Mark read</button>
              {:else if letter.state === 'read'}
                <button type="button" onclick={() => void transition(letter, 'archive')} disabled={busy === letter.id} class="text-sm font-medium text-shadow-600">Archive</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>
