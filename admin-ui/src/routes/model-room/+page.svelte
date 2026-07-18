<script lang="ts">
  // The Atrium merged into The Canopy (/chat): the model roster, per-participant
  // system prompts, and room rounds now live there under "Participants & Model
  // Roster", and past room transcripts under the Transcripts tab. This route is
  // kept only so old links and bookmarks don't 404.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  onMount(() => {
    void goto(scopeGardenPath('/chat'), { replaceState: true });
  });
</script>

<div class="card-garden p-6">
  <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Atrium has moved</h1>
  <p class="text-shadow-600 text-sm mt-1">
    Multi-model rounds now live in the chat console. Redirecting...
  </p>
  <a href={scopeGardenPath('/chat')} class="inline-block mt-3 text-sm text-shadow-700 underline hover:text-shadow-900">
    Continue to Chat
  </a>
</div>
