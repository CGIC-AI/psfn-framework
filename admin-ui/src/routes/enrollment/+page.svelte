<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getEnrollments,
    enrollHubIdentity,
    revokeEnrollment,
    type AdminEnrollmentBindingView,
  } from '$lib/api/endpoints/enrollment';
  import { pushToast } from '$lib/stores/toast.svelte';

  let enrollments = $state<AdminEnrollmentBindingView[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');

  // Bind form.
  let hubIdentityId = $state('');
  let canonicalContactId = $state('');
  let satelliteId = $state('');
  let endpointId = $state('');
  let submitting = $state(false);

  let revokingId = $state('');

  let activeCount = $derived(enrollments.filter((e) => e.status === 'enrolled').length);

  async function loadData(): Promise<void> {
    errorMessage = '';
    try {
      const data = await getEnrollments();
      enrollments = data.enrollments;
      total = data.total;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load enrollments.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshData(): Promise<void> {
    refreshing = true;
    await loadData();
  }

  async function submitBind(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!hubIdentityId.trim() || !canonicalContactId.trim()) {
      pushToast('Hub identity and contact are both required', 'error');
      return;
    }
    submitting = true;
    try {
      await enrollHubIdentity({
        hubIdentityId: hubIdentityId.trim(),
        canonicalContactId: canonicalContactId.trim(),
        ...(satelliteId.trim() ? { satelliteId: satelliteId.trim() } : {}),
        ...(endpointId.trim() ? { endpointId: endpointId.trim() } : {}),
      });
      pushToast(`Enrolled ${hubIdentityId.trim()}`, 'success');
      hubIdentityId = '';
      canonicalContactId = '';
      satelliteId = '';
      endpointId = '';
      await loadData();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Enrollment failed', 'error');
    } finally {
      submitting = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    if (revokingId) return;
    revokingId = id;
    try {
      await revokeEnrollment(id);
      pushToast(`Revoked ${id}`, 'success');
      await loadData();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Revoke failed', 'error');
    } finally {
      revokingId = '';
    }
  }

  function formatTimestamp(iso: string | null): string {
    if (!iso) return '—';
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">Recognition Seam</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Enrollment</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Bind an opaque hub-identity handle to an <em>existing</em> contact. Biometric templates live
        entirely at the Satellite Hub and never enter core — only the handle, the contact link, and
        audit metadata are stored here. Enroll fails closed if the contact does not exist.
      </p>
    </div>
    <button
      onclick={refreshData}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  <section class="card-garden p-5 space-y-4" aria-label="Bind a hub identity">
    <div>
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Bind a hub identity</h2>
      <p class="mt-1 text-sm text-shadow-600">The contact must already exist — this never creates one.</p>
    </div>
    <form class="grid gap-4 sm:grid-cols-2" onsubmit={submitBind}>
      <label class="space-y-1">
        <span class="text-xs uppercase tracking-[0.14em] text-shadow-500">Hub Identity ID <span class="text-wilt-500">*</span></span>
        <input
          bind:value={hubIdentityId}
          type="text"
          required
          placeholder="opaque handle"
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800 placeholder:text-shadow-400"
        />
      </label>
      <label class="space-y-1">
        <span class="text-xs uppercase tracking-[0.14em] text-shadow-500">Contact ID <span class="text-wilt-500">*</span></span>
        <input
          bind:value={canonicalContactId}
          type="text"
          required
          placeholder="existing contact id"
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800 placeholder:text-shadow-400"
        />
      </label>
      <label class="space-y-1">
        <span class="text-xs uppercase tracking-[0.14em] text-shadow-500">Satellite ID <span class="text-shadow-400">(optional)</span></span>
        <input
          bind:value={satelliteId}
          type="text"
          placeholder="satellite id"
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800 placeholder:text-shadow-400"
        />
      </label>
      <label class="space-y-1">
        <span class="text-xs uppercase tracking-[0.14em] text-shadow-500">Endpoint ID <span class="text-shadow-400">(optional)</span></span>
        <input
          bind:value={endpointId}
          type="text"
          placeholder="endpoint id"
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800 placeholder:text-shadow-400"
        />
      </label>
      <div class="sm:col-span-2">
        <button
          type="submit"
          disabled={submitting}
          class="rounded-xl bg-gold-600 px-4 py-2 text-sm font-semibold text-bark-50 transition-colors hover:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Enrolling...' : 'Enroll'}
        </button>
      </div>
    </form>
  </section>

  <section class="space-y-4" aria-label="Current bindings">
    <div class="flex items-baseline gap-3">
      <h2 class="text-lg font-serif font-semibold text-shadow-900">Bindings</h2>
      <span class="text-sm text-shadow-500">{activeCount} active · {total} total</span>
    </div>

    {#if loading}
      <div class="card-garden animate-pulse p-5">
        <div class="h-4 w-40 rounded bg-bark-200"></div>
        <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
      </div>
    {:else if enrollments.length === 0}
      <div class="card-garden p-8 text-center">
        <p class="text-sm text-shadow-500">No hub identities are enrolled yet.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each enrollments as binding (binding.hubIdentityId)}
          <article class="card-garden p-5">
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <div class="space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <p class="font-mono text-sm text-shadow-900">{binding.hubIdentityId}</p>
                  <span
                    class="rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em]"
                    class:bg-moss-50={binding.status === 'enrolled'}
                    class:text-moss-700={binding.status === 'enrolled'}
                    class:bg-bark-200={binding.status === 'revoked'}
                    class:text-shadow-600={binding.status === 'revoked'}
                  >{binding.status}</span>
                </div>
                <p class="text-sm text-shadow-700">→ contact <span class="font-mono">{binding.canonicalContactId}</span></p>
                {#if binding.satelliteId || binding.endpointId}
                  <p class="text-xs text-shadow-500">
                    {#if binding.satelliteId}satellite <span class="font-mono">{binding.satelliteId}</span>{/if}
                    {#if binding.endpointId} · endpoint <span class="font-mono">{binding.endpointId}</span>{/if}
                  </p>
                {/if}
              </div>
              {#if binding.status === 'enrolled'}
                <button
                  onclick={() => revoke(binding.hubIdentityId)}
                  disabled={revokingId === binding.hubIdentityId}
                  class="rounded-lg border border-wilt-300 px-3 py-1.5 text-sm font-medium text-wilt-700 transition-colors hover:bg-wilt-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {revokingId === binding.hubIdentityId ? 'Revoking...' : 'Revoke'}
                </button>
              {/if}
            </div>
            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Enrolled</dt>
                <dd class="mt-1 text-shadow-700">{formatTimestamp(binding.enrolledAt)} · {binding.enrolledBy}</dd>
              </div>
              {#if binding.status === 'revoked'}
                <div>
                  <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Revoked</dt>
                  <dd class="mt-1 text-shadow-700">{formatTimestamp(binding.revokedAt)} · {binding.revokedBy ?? '—'}</dd>
                </div>
              {/if}
            </dl>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>
