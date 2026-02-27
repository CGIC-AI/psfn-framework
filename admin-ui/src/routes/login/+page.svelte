<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { setToken } from '$lib/stores/auth.svelte';

  let tokenInput = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!tokenInput.trim()) {
      error = 'Please enter a token.';
      return;
    }

    loading = true;
    error = '';

    try {
      const res = await fetch('/api/admin/dashboard', {
        headers: {
          Authorization: `Bearer ${tokenInput.trim()}`,
          Accept: 'application/json',
        },
      });

      if (res.ok) {
        setToken(tokenInput.trim());
        goto(`${base}`);
      } else if (res.status === 401 || res.status === 403) {
        error = 'Invalid token. Please try again.';
      } else {
        error = `Server error (${res.status}). Is the admin server running?`;
      }
    } catch {
      error = 'Could not connect to the admin server. Is it running on port 3001?';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-bark-100 p-4">
  <div class="card max-w-md w-full p-8">
    <div class="text-center mb-8">
      <h1 class="font-serif text-3xl text-gold-600 font-semibold">
        Purrsephone's Garden
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
          placeholder="Enter ADMIN_TOKEN..."
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
          Authenticating...
        {:else}
          Enter the Garden
        {/if}
      </button>
    </form>

    <p class="text-center text-sm text-shadow-600 mt-6">
      Token is configured via <code class="px-1.5 py-0.5 bg-bark-200 rounded text-shadow-800">ADMIN_TOKEN</code> env var
    </p>
  </div>
</div>
