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

<main class="flex min-h-dvh w-full bg-canvas text-ink">
  <section class="relative hidden w-[46%] shrink-0 overflow-hidden border-r border-line bg-sunken lg:block" aria-label="About this Garden">
    <!-- Pure-CSS engraving treatment: the shared login language forbids remote assets. -->
    <div class="engraving absolute inset-0" aria-hidden="true"></div>
    <div class="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-gold-300/45" aria-hidden="true"></div>
    <div class="pointer-events-none absolute -right-10 top-10 h-40 w-40 rounded-full border border-gold-300/65" aria-hidden="true"></div>
    <div class="absolute inset-0 bg-gradient-to-t from-canvas/95 via-canvas/10 to-transparent" aria-hidden="true"></div>

    <div class="absolute inset-x-0 bottom-0 p-10">
      <p class="page-kicker tracking-[0.22em] text-gold-600">
        PSFN Companion Framework
      </p>
      <p class="mt-3 max-w-md font-serif text-2xl leading-snug text-ink">
        &ldquo;A garden is only as tended as its keeper is present.&rdquo;
      </p>
      <dl class="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-[0_1px_2px_rgb(38_35_30/0.04),0_1px_12px_rgb(38_35_30/0.03)] xl:grid-cols-3">
        <div class="bg-surface px-4 py-3">
          <dt class="text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-muted">Scope</dt>
          <dd class="mt-1 font-serif text-xl leading-none text-ink">One Garden</dd>
        </div>
        <div class="bg-surface px-4 py-3">
          <dt class="text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-muted">Session</dt>
          <dd class="mt-1 font-serif text-xl leading-none text-ink">Operator only</dd>
        </div>
        <div class="bg-surface px-4 py-3">
          <dt class="text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-muted">Access</dt>
          <dd class="mt-1 font-serif text-xl leading-none text-gold-600">Token protected</dd>
        </div>
      </dl>
    </div>
  </section>

  <section class="flex flex-1 items-center justify-center px-6 py-12">
    <div class="w-full max-w-md">
      <div class="flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl border border-gold-300/70 bg-gold-50 font-serif text-lg text-gold-600" aria-hidden="true">P</span>
        <div>
          <p class="font-serif text-lg leading-tight text-ink">PSFN</p>
          <p class="text-xs text-muted">{companionName}'s Garden</p>
        </div>
      </div>

      <span class="my-7 block h-px w-full bg-gradient-to-r from-gold-300 via-line to-transparent" aria-hidden="true"></span>

      <h1 class="font-serif text-4xl leading-tight text-ink">Welcome back.</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted">
        Use the admin token issued for this Garden. Access is limited to authorized operators.
      </p>

      <form onsubmit={handleSubmit} class="mt-7 space-y-5" aria-busy={loading}>
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
          class="garden-action garden-action--primary min-h-12 w-full text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {#if loading}
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true"></span>
            Entering the Garden…
          {:else}
            Enter the Garden
            <span aria-hidden="true">→</span>
          {/if}
        </button>
      </form>

      <p class="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Failed requests remain on this page without exposing system details.
      </p>

      <p class="mt-6 border-t border-line pt-5 text-center text-[0.6875rem] leading-relaxed text-muted">
        Trouble getting in? Ask a cluster admin to re-issue your admin token.
      </p>
    </div>
  </section>
</main>

<style>
  .engraving {
    background:
      radial-gradient(60% 50% at 70% 20%, rgb(194 154 43 / 0.10), transparent 70%),
      radial-gradient(45% 40% at 20% 75%, rgb(79 122 82 / 0.08), transparent 70%),
      repeating-linear-gradient(
        115deg,
        transparent 0,
        transparent 11px,
        rgb(38 35 30 / 0.025) 11px,
        rgb(38 35 30 / 0.025) 12px
      );
  }

  @media (prefers-reduced-motion: reduce) {
    .engraving {
      background:
        radial-gradient(60% 50% at 70% 20%, rgb(194 154 43 / 0.10), transparent 70%),
        radial-gradient(45% 40% at 20% 75%, rgb(79 122 82 / 0.08), transparent 70%);
    }
  }
</style>
