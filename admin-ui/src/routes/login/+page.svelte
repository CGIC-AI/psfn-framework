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

<svelte:head>
  <title>Sign in · {companionName}'s Garden</title>
</svelte:head>

<main class="grid min-h-dvh place-items-center bg-canvas px-4 py-8 sm:px-6 lg:px-8">
  <div class="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_70px_rgb(38_35_30/0.10)] lg:grid-cols-[1.08fr_0.92fr]">
    <section class="relative overflow-hidden border-b border-line bg-sunken px-6 py-8 sm:px-10 sm:py-12 lg:border-b-0 lg:border-r lg:px-12 lg:py-16">
      <div class="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full border border-gold-300/45" aria-hidden="true"></div>
      <div class="pointer-events-none absolute -right-8 top-9 h-36 w-36 rounded-full border border-gold-300/65" aria-hidden="true"></div>

      <div class="relative flex h-full max-w-xl flex-col">
        <div class="inline-flex w-fit items-center gap-2 rounded-full border border-gold-300 bg-gold-50 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-gold-700">
          <span class="h-1.5 w-1.5 rounded-full bg-moss-500" aria-hidden="true"></span>
          Private operator surface
        </div>
        <p class="page-kicker mt-8">Garden · Companion administration</p>
        <h1 class="mt-2 max-w-lg font-serif text-4xl font-semibold leading-[1.08] text-ink sm:text-5xl">
          Tend {companionName}'s living system.
        </h1>
        <p class="mt-4 max-w-lg text-sm leading-6 text-muted sm:text-base">
          One focused place for memory, runtime health, relationships, policy, and the decisions that need a human hand.
        </p>

        <dl class="mt-10 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:mt-auto lg:grid-cols-1 xl:grid-cols-3">
          <div class="bg-surface/80 px-4 py-3 backdrop-blur-sm">
            <dt class="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted">Scope</dt>
            <dd class="mt-1 font-serif text-sm font-semibold text-ink">One companion</dd>
          </div>
          <div class="bg-surface/80 px-4 py-3 backdrop-blur-sm">
            <dt class="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted">Session</dt>
            <dd class="mt-1 font-serif text-sm font-semibold text-ink">Operator only</dd>
          </div>
          <div class="bg-surface/80 px-4 py-3 backdrop-blur-sm">
            <dt class="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted">Access</dt>
            <dd class="mt-1 font-serif text-sm font-semibold text-ink">Token protected</dd>
          </div>
        </dl>
      </div>
    </section>

    <section class="flex items-center px-6 py-9 sm:px-10 sm:py-12 lg:px-12">
      <div class="w-full">
        <p class="page-kicker">Secure access</p>
        <h2 class="page-title mt-1">Welcome back</h2>
        <p class="page-description mt-2">Use the admin token issued for this Garden.</p>

        <form onsubmit={handleSubmit} class="mt-8 space-y-5" aria-busy={loading}>
          <div class="garden-field">
            <label for="token">Admin token</label>
            <input
              id="token"
              type="password"
              bind:value={tokenInput}
              placeholder="Paste your admin token"
              autocomplete="current-password"
              spellcheck="false"
              aria-describedby={error ? 'token-hint token-error' : 'token-hint'}
              aria-invalid={error ? 'true' : undefined}
              class="min-h-11 w-full"
              disabled={loading}
            />
            <p id="token-hint" class="garden-field-hint">The token stays in this authenticated operator session.</p>
          </div>

          {#if error}
            <div id="token-error" class="garden-error min-h-0 px-3 py-2.5 text-sm" role="alert">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-wilt-100 text-xs font-bold text-wilt-700" aria-hidden="true">!</span>
              <span>{error}</span>
            </div>
          {/if}

          <button
            type="submit"
            disabled={loading}
            class="garden-action garden-action--primary w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {#if loading}
              <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white" aria-hidden="true"></span>
              Signing in…
            {:else}
              Enter the Garden
              <span aria-hidden="true">→</span>
            {/if}
          </button>
        </form>

        <p class="mt-6 border-t border-line pt-5 text-xs leading-5 text-muted">
          Access is limited to authorized operators. Failed requests remain on this page without exposing system details.
        </p>
      </div>
    </section>
  </div>
</main>
