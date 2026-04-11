<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { setToken } from '$lib/stores/auth.svelte';
  import { getCompanionName } from '$lib/stores/companion.svelte';

  let tokenInput = $state('');
  let error = $state('');
  let loading = $state(false);
  const companionName = $derived(getCompanionName());

  function resolveGardenRootPath(): string {
    return base || '/';
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token) {
      error = 'Please enter a token.';
      return;
    }

    loading = true;
    error = '';

    try {
      const body = new URLSearchParams({ token });
      const res = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
        },
        credentials: 'include',
        body: body.toString(),
      });

      if (res.redirected) {
        setToken(token);
        if (typeof window !== 'undefined') {
          window.location.assign(resolveGardenRootPath());
        } else {
          await goto(resolveGardenRootPath(), { replaceState: true });
        }
      } else if (res.status === 401 || res.status === 403) {
        error = 'Invalid token. Please try again.';
      } else {
        const bodyText = await res.text().catch(() => '');
        error = /invalid token/i.test(bodyText)
          ? 'Invalid token. Please try again.'
          : `Server error (${res.status}). Could not complete sign-in.`;
      }
    } catch {
      error = 'Could not connect to the operator surface.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-bark-100 p-4">
  <div class="card max-w-md w-full p-8">
    <div class="text-center mb-8">
      <h1 class="font-serif text-3xl text-gold-600 font-semibold">
        {companionName}'s Garden
      </h1>
      <p class="text-shadow-700 mt-2 text-sm">
        Enter your admin token to continue
      </p>
    </div>

    <form onsubmit={handleSubmit} class="space-y-4">
      <div>
        <label for="token" class="block text-sm font-medium text-shadow-600 mb-1.5">
          Admin Token
        </label>
        <input
          id="token"
          type="password"
          bind:value={tokenInput}
          placeholder="Enter admin token..."
          class="w-full px-4 py-2.5 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                 placeholder:text-shadow-500 focus:outline-none focus:border-gold-400 focus:ring-2
                 focus:ring-gold-200 transition-colors"
          disabled={loading}
        />
      </div>

      {#if error}
        <div class="px-4 py-2.5 rounded-lg bg-wilt-50 border border-wilt-200 text-wilt-600 text-sm">
          {error}
        </div>
      {/if}

      <button
        type="submit"
        disabled={loading}
        class="w-full py-2.5 rounded-lg bg-gold-400 text-bark-50 font-medium
               hover:bg-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-300
               disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {#if loading}
          Signing in...
        {:else}
          Sign in
        {/if}
      </button>
    </form>
  </div>
</div>
