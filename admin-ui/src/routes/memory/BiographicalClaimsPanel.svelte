<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getBiographicalClaim,
    listBiographicalClaims,
    reviewBiographicalClaim,
    type BiographicalReviewRequest,
  } from '$lib/api/endpoints/memory';
  import type {
    AdminBiographicalClaimDetail,
    AdminBiographicalClaimView,
  } from '$lib/types';

  const CLAIM_STATES = [
    'all', 'active', 'candidate', 'contested', 'quarantined', 'superseded', 'revoked',
  ] as const;
  const SENSITIVITY_LEVELS = ['public', 'personal', 'intimate', 'confidential'] as const;

  let claims = $state<AdminBiographicalClaimView[]>([]);
  let detail = $state<AdminBiographicalClaimDetail | null>(null);
  let selectedId = $state<string | null>(null);
  let statusFilter = $state<(typeof CLAIM_STATES)[number]>('all');
  let query = $state('');
  let loading = $state(true);
  let detailLoading = $state(false);
  let mutating = $state(false);
  let error = $state('');
  let notice = $state('');
  let grantedSensitivity = $state<(typeof SENSITIVITY_LEVELS)[number]>('personal');

  let filteredClaims = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return claims.filter(claim => {
      if (statusFilter !== 'all' && claim.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        claim.renderedValue,
        claim.kind,
        claim.status,
        subjectLabel(claim),
      ].some(value => value.toLowerCase().includes(needle));
    });
  });

  function subjectLabel(claim: AdminBiographicalClaimView): string {
    const primary = claim.subject.kind === 'contact'
      ? `Contact ${claim.subject.contactId}`
      : `Companion ${claim.subject.companionId}`;
    if (!claim.relatedSubject) return primary;
    const related = claim.relatedSubject.kind === 'contact'
      ? `Contact ${claim.relatedSubject.contactId}`
      : `Companion ${claim.relatedSubject.companionId}`;
    return `${primary} ↔ ${related}`;
  }

  function statusClass(status: string): string {
    if (status === 'active') return 'garden-status--success';
    if (status === 'revoked' || status === 'quarantined') return 'garden-status--danger';
    if (status === 'candidate' || status === 'contested') return 'garden-status--warning';
    return '';
  }

  function shortDigest(value: string): string {
    return `${value.slice(0, 10)}…${value.slice(-8)}`;
  }

  function formatTimestamp(value: string | undefined): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  function currentDriftDigest(): string | null {
    const rebuild = detail?.rebuilds.find(item =>
      item.status === 'pending'
      && item.currentSourceSetDigest !== undefined
      && item.currentSourceSetDigest !== item.priorSourceSetDigest
    );
    return rebuild?.currentSourceSetDigest ?? null;
  }

  function hasActiveCurrentGrant(): boolean {
    const digest = currentDriftDigest();
    if (!detail || !digest) return false;
    const now = Date.now();
    return detail.grants.some(grant =>
      grant.sourceSetDigest === digest
      && grant.revokedAt === undefined
      && Date.parse(grant.grantedAt) <= now
      && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now)
    );
  }

  async function loadClaims(preferredId: string | null = selectedId): Promise<void> {
    loading = true;
    error = '';
    try {
      const result = await listBiographicalClaims();
      claims = [...result.claims];
      const nextId = preferredId && claims.some(claim => claim.id === preferredId)
        ? preferredId
        : claims[0]?.id ?? null;
      if (nextId) await selectClaim(nextId);
      else {
        selectedId = null;
        detail = null;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed to load biographical claims';
    } finally {
      loading = false;
    }
  }

  async function selectClaim(id: string): Promise<void> {
    selectedId = id;
    detailLoading = true;
    error = '';
    try {
      detail = await getBiographicalClaim(id);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed to load claim detail';
      detail = null;
    } finally {
      detailLoading = false;
    }
  }

  async function applyReview(request: BiographicalReviewRequest, label: string): Promise<void> {
    if (!detail || mutating) return;
    const digestSummary = `${shortDigest(request.claimDigest)} / ${shortDigest(request.sourceSetDigest)}`;
    if (!window.confirm(`${label} this exact claim and source-set revision?\n${digestSummary}`)) return;
    mutating = true;
    error = '';
    notice = '';
    try {
      detail = await reviewBiographicalClaim(detail.claim.id, request);
      notice = `${label} recorded with exact-digest audit evidence.`;
      await loadClaims(detail.claim.id);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : `${label} failed`;
    } finally {
      mutating = false;
    }
  }

  function approveOrDeny(action: 'approve' | 'deny'): void {
    if (!detail) return;
    void applyReview({
      action,
      claimDigest: detail.claim.claimDigest,
      sourceSetDigest: detail.claim.storedSourceSetDigest,
    }, action === 'approve' ? 'Approve' : 'Deny');
  }

  function revokeGrant(grantId: string, sourceSetDigest: string): void {
    if (!detail) return;
    void applyReview({
      action: 'revoke',
      claimDigest: detail.claim.claimDigest,
      sourceSetDigest,
      grantId,
    }, 'Revoke grant');
  }

  function regrant(): void {
    if (!detail) return;
    const digest = currentDriftDigest();
    if (!digest) return;
    void applyReview({
      action: 'regrant',
      claimDigest: detail.claim.claimDigest,
      sourceSetDigest: digest,
      grantedSensitivity,
    }, 'Re-grant');
  }

  onMount(() => { void loadClaims(); });
</script>

<section class="garden-section card-garden overflow-hidden" aria-labelledby="biographical-claims-heading">
  <div class="garden-section-header flex flex-col gap-3 border-b border-bark-200 p-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-gold-700">Stable biography</p>
      <h2 id="biographical-claims-heading" class="garden-section-title mt-1 font-serif text-xl text-shadow-900">
        Claim review
      </h2>
      <p class="garden-section-description mt-1 max-w-3xl text-sm text-shadow-600">
        Inspect durable profile claims and exact source revisions. Source bodies never appear here.
      </p>
    </div>
    <button class="garden-action min-h-10 px-3" disabled={loading} onclick={() => { void loadClaims(); }}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>

  <div class="garden-toolbar grid gap-3 border-b border-bark-200 bg-bark-50 p-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
    <label class="garden-field">
      <span class="sr-only">Search claims</span>
      <input
        class="w-full rounded-lg border border-bark-300 bg-surface px-3 py-2 text-sm text-shadow-900"
        placeholder="Search claim, subject, kind…"
        bind:value={query}
      />
    </label>
    <label class="garden-field">
      <span class="sr-only">Filter by claim state</span>
      <select class="w-full rounded-lg border border-bark-300 bg-surface px-3 py-2 text-sm" bind:value={statusFilter}>
        {#each CLAIM_STATES as state}
          <option value={state}>{state === 'all' ? 'All claim states' : state}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if error}
    <div class="garden-error m-4 rounded-lg border border-wilt-300 bg-wilt-50 p-3 text-sm text-wilt-700" role="alert">{error}</div>
  {/if}
  {#if notice}
    <div class="garden-status garden-status--success m-4 rounded-lg border border-moss-300 bg-moss-50 p-3 text-sm text-moss-700" role="status">{notice}</div>
  {/if}

  <div class="garden-split-view grid min-h-[34rem] lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.7fr)]">
    <div class="border-b border-bark-200 lg:border-b-0 lg:border-r">
      <div class="flex items-center justify-between px-4 py-2 text-xs uppercase tracking-[0.14em] text-shadow-500">
        <span>{filteredClaims.length} claims</span>
        <span>All states</span>
      </div>
      {#if loading && claims.length === 0}
        <p class="garden-loading p-6 text-sm text-shadow-600">Loading durable claims…</p>
      {:else if filteredClaims.length === 0}
        <p class="garden-empty p-6 text-sm text-shadow-600">No claims match this view.</p>
      {:else}
        <div class="max-h-[38rem] divide-y divide-bark-200 overflow-y-auto">
          {#each filteredClaims as claim (claim.id)}
            <button
              class="block min-h-16 w-full px-4 py-3 text-left transition {selectedId === claim.id ? 'bg-gold-50 shadow-[inset_3px_0_0_var(--color-gold-500)]' : 'hover:bg-bark-50'}"
              onclick={() => { void selectClaim(claim.id); }}
            >
              <span class="flex items-start justify-between gap-2">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold text-shadow-900">{claim.renderedValue}</span>
                  <span class="mt-1 block truncate text-xs text-shadow-500">{subjectLabel(claim)} · {claim.kind}</span>
                </span>
                <span class="garden-status {statusClass(claim.status)} shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                  {claim.status}
                </span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="min-w-0 p-4 sm:p-5">
      {#if detailLoading}
        <p class="garden-loading text-sm text-shadow-600">Loading structured claim detail…</p>
      {:else if !detail}
        <p class="garden-empty text-sm text-shadow-600">Select a claim to inspect its evidence contract.</p>
      {:else}
        <div class="space-y-5">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="garden-status {statusClass(detail.claim.status)} rounded-full px-2.5 py-1 text-xs font-semibold">{detail.claim.status}</span>
                <span class="rounded-full bg-bark-100 px-2.5 py-1 text-xs text-shadow-600">{detail.claim.kind}</span>
              </div>
              <h3 class="mt-3 font-serif text-2xl text-shadow-900">{detail.claim.renderedValue}</h3>
              <p class="mt-1 text-sm text-shadow-600">{subjectLabel(detail.claim)}</p>
            </div>
            {#if ['candidate', 'contested', 'quarantined'].includes(detail.claim.status)}
              <div class="flex gap-2">
                <button class="garden-action garden-action--primary min-h-10 px-3" disabled={mutating} onclick={() => approveOrDeny('approve')}>Approve</button>
                <button class="garden-action garden-action--danger min-h-10 px-3" disabled={mutating} onclick={() => approveOrDeny('deny')}>Deny</button>
              </div>
            {/if}
          </div>

          <div class="garden-metric-grid grid gap-3 sm:grid-cols-3">
            <div class="garden-metric rounded-xl border border-bark-200 bg-bark-50 p-3">
              <p class="text-xs uppercase tracking-wide text-shadow-500">Effective sensitivity</p>
              <p class="mt-1 font-semibold text-shadow-900">{detail.claim.effectiveSensitivity ?? 'Pending rebuild'}</p>
              {#if !detail.claim.sensitivitySnapshotCurrent}
                <p class="mt-1 text-xs text-gold-700">Stored snapshot: {detail.claim.storedEffectiveSensitivity}</p>
              {/if}
            </div>
            <div class="garden-metric rounded-xl border border-bark-200 bg-bark-50 p-3">
              <p class="text-xs uppercase tracking-wide text-shadow-500">Automatic floor</p>
              <p class="mt-1 font-semibold text-shadow-900">{detail.claim.automaticSensitivity ?? 'Revalidation pending'}</p>
              <p class="mt-1 text-xs text-shadow-500">Proposed {detail.claim.proposedSensitivity}</p>
            </div>
            <div class="garden-metric rounded-xl border border-bark-200 bg-bark-50 p-3">
              <p class="text-xs uppercase tracking-wide text-shadow-500">Source revisions</p>
              <p class="mt-1 font-semibold text-shadow-900">{detail.claim.sources.length}</p>
              <p class="mt-1 text-xs text-shadow-500">Validated {formatTimestamp(detail.claim.lastSourceValidatedAt)}</p>
            </div>
          </div>

          {#if detail.claim.withheldReasons.length > 0}
            <div class="garden-status garden-status--warning rounded-xl border border-gold-300 bg-gold-50 p-3">
              <p class="text-xs font-semibold uppercase tracking-wide text-gold-800">Currently withheld</p>
              <p class="mt-1 text-sm text-shadow-800">{detail.claim.withheldReasons.join(' · ')}</p>
            </div>
          {/if}
          {#if detail.claim.pendingRebuildReasons.length > 0}
            <div class="rounded-xl border border-bark-200 bg-bark-50 p-3">
              <p class="text-xs font-semibold uppercase tracking-wide text-shadow-600">Reconciliation pending</p>
              <p class="mt-1 text-sm text-shadow-700">{detail.claim.pendingRebuildReasons.join(' · ')}</p>
              <p class="mt-1 text-xs text-shadow-500">A pending rebuild can coexist with an exact current-digest grant.</p>
            </div>
          {/if}

          <details class="rounded-xl border border-bark-200 bg-surface" open>
            <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-shadow-900">Structured value and exact digests</summary>
            <div class="space-y-3 border-t border-bark-200 p-4">
              <pre class="overflow-x-auto rounded-lg bg-bark-50 p-3 text-xs text-shadow-800">{JSON.stringify(detail.claim.structuredValue, null, 2)}</pre>
              <dl class="grid gap-2 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt class="text-shadow-500">Claim digest</dt><dd class="break-all font-mono text-shadow-800">{detail.claim.claimDigest}</dd>
                <dt class="text-shadow-500">Current source set</dt><dd class="break-all font-mono text-shadow-800">{detail.claim.sourceSetDigest}</dd>
                <dt class="text-shadow-500">Stored source set</dt><dd class="break-all font-mono text-shadow-800">{detail.claim.storedSourceSetDigest}</dd>
              </dl>
            </div>
          </details>

          <div>
            <h4 class="text-sm font-semibold text-shadow-900">Source references</h4>
            <div class="garden-table-shell garden-table-scroll mt-2 overflow-x-auto rounded-xl border border-bark-200">
              <table class="garden-table min-w-full text-left text-xs">
                <thead><tr><th>Reference</th><th>Revision</th><th>Evidence digest</th><th>Contribution</th></tr></thead>
                <tbody>
                  {#each detail.claim.sources as source}
                    <tr>
                      <td class="font-mono">{source.ref}</td>
                      <td>{source.revision}</td>
                      <td class="font-mono" title={source.evidenceDigest}>{shortDigest(source.evidenceDigest)}</td>
                      <td>{source.sensitivityContribution}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between gap-3">
              <h4 class="text-sm font-semibold text-shadow-900">Exact grants</h4>
              {#if currentDriftDigest() && detail.claim.status === 'active' && !hasActiveCurrentGrant()}
                <div class="flex items-center gap-2">
                  <select class="min-h-10 rounded-lg border border-bark-300 bg-surface px-2 text-xs" bind:value={grantedSensitivity}>
                    {#each SENSITIVITY_LEVELS as level}<option value={level}>{level}</option>{/each}
                  </select>
                  <button class="garden-action garden-action--primary min-h-10 px-3" disabled={mutating} onclick={regrant}>Re-grant current digest</button>
                </div>
              {/if}
            </div>
            {#if detail.grants.length === 0}
              <p class="garden-empty mt-2 rounded-lg bg-bark-50 p-3 text-sm text-shadow-600">No sensitivity grants.</p>
            {:else}
              <div class="mt-2 space-y-2">
                {#each detail.grants as grant}
                  <div class="flex flex-col gap-2 rounded-xl border border-bark-200 bg-bark-50 p-3 sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1 text-xs text-shadow-700">
                      <p><strong>{grant.grantedSensitivity}</strong> · {grant.authorizingActor} · {grant.revokedAt ? 'revoked' : 'active'}</p>
                      <p class="mt-1 truncate font-mono" title={grant.sourceSetDigest}>{shortDigest(grant.sourceSetDigest)}</p>
                    </div>
                    {#if !grant.revokedAt}
                      <button class="garden-action garden-action--danger min-h-10 px-3" disabled={mutating} onclick={() => revokeGrant(grant.id, grant.sourceSetDigest)}>Revoke</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="grid gap-4 xl:grid-cols-2">
            <div>
              <h4 class="text-sm font-semibold text-shadow-900">Rebuild history</h4>
              <div class="mt-2 space-y-2">
                {#each detail.rebuilds as rebuild}
                  <div class="rounded-xl border border-bark-200 p-3 text-xs text-shadow-700">
                    <p><strong>{rebuild.reason}</strong> · {rebuild.status}{rebuild.completion ? ` / ${rebuild.completion}` : ''}</p>
                    <p class="mt-1 font-mono">old {shortDigest(rebuild.priorSourceSetDigest)}</p>
                    {#if rebuild.currentSourceSetDigest}<p class="font-mono">new {shortDigest(rebuild.currentSourceSetDigest)}</p>{/if}
                  </div>
                {:else}
                  <p class="garden-empty rounded-lg bg-bark-50 p-3 text-sm text-shadow-600">No rebuild events.</p>
                {/each}
              </div>
            </div>
            <div>
              <h4 class="text-sm font-semibold text-shadow-900">Append-only review audit</h4>
              <div class="mt-2 space-y-2">
                {#each detail.audits as audit}
                  <div class="rounded-xl border border-bark-200 p-3 text-xs text-shadow-700">
                    <p><strong>{audit.action}</strong> · {audit.decision} · {audit.reason}</p>
                    <p class="mt-1">{formatTimestamp(audit.recordedAt)} · {audit.actorAuthorityRef}</p>
                  </div>
                {:else}
                  <p class="garden-empty rounded-lg bg-bark-50 p-3 text-sm text-shadow-600">No operator reviews yet.</p>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</section>
