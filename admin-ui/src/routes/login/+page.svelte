<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { setToken, validateToken } from '$lib/stores/auth.svelte';

  let token = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!token.trim()) {
      error = 'Please enter your admin token';
      return;
    }

    loading = true;
    error = '';

    const valid = await validateToken(token.trim());
    if (valid) {
      setToken(token.trim());
      goto(`${base}/`);
    } else {
      error = 'Invalid token — could not authenticate';
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-bark-50 px-4">
  <div class="w-full max-w-sm">
    <!-- Garden ornament -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gold-50 border border-gold-200 mb-4">
        <svg class="w-8 h-8 text-gold-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2C8 2 5 5.5 5 10c0 2.5 1 4.5 2.5 6H11v4h2v-4h3.5c1.5-1.5 2.5-3.5 2.5-6 0-4.5-3-8-7-8z" />
        </svg>
      </div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800">admin UI</h1>
      <p class="text-sm text-shadow-400 mt-1">Enter your admin token to continue</p>
    </div>

    <!-- Login form -->
    <form onsubmit={handleSubmit} class="card-garden p-6 space-y-4">
      <div>
        <label for="token" class="block text-sm font-medium text-shadow-700 mb-1.5">Admin Token</label>
        <input
          id="token"
          type="password"
          bind:value={token}
          placeholder="Enter token..."
          class="w-full px-3 py-2.5 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 placeholder:text-shadow-300
            focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 transition-colors"
          disabled={loading}
        />
      </div>

      {#if error}
        <div class="text-sm text-wilt-600 bg-wilt-50 border border-wilt-200 rounded-lg px-3 py-2">
          {error}
        </div>
      {/if}

      <button
        type="submit"
        class="w-full py-2.5 px-4 rounded-lg bg-gold-600 text-white font-medium text-sm
          hover:bg-gold-700 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:ring-offset-2
          disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        disabled={loading}
      >
        {loading ? 'Verifying...' : 'Enter the Garden'}
      </button>
    </form>
  </div>
</div>
