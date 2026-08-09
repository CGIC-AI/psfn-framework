<script lang="ts">
  // The Atrium merged into The Canopy (/chat): the model roster, per-participant
  // system prompts, and room rounds now live there under "Participants & Model
  // Roster", and past room transcripts under the Transcripts tab. This route is
  // kept only so old links and bookmarks don't 404.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';

  onMount(() => {
    void goto(scopeGardenPath('/chat'), { replaceState: true });
  });
</script>

<div class="garden-page space-y-5 pb-10">
  <GardenPageHeader
    eyebrow="Runtime & Tools · Model room"
    title="The Atrium"
    description="Multi-model rooms now live inside the unified chat console."
    class="border-b border-bark-300 pb-4"
  />
  <section class="garden-empty card-garden mx-auto max-w-2xl border-l-4 border-l-gold-400 p-8 text-center">
    <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold-300 bg-gold-50 font-serif text-xl text-gold-700" aria-hidden="true">↗</span>
    <h2 class="mt-4 font-serif text-xl font-semibold text-shadow-900">The Atrium has moved</h2>
    <p class="mt-2 text-sm text-shadow-600">Participants, model rosters, room rounds, and transcripts are now managed together. Redirecting…</p>
    <a href={scopeGardenPath('/chat')} class="garden-action garden-action--primary mt-5 inline-flex rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gold-700">
      Continue to Chat
    </a>
  </section>
</div>
