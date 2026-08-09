<script lang="ts">
  import { onMount } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getChannelEnvelopeData,
    saveChannelEnvelopeLabel,
    getChannelDemotionNotice,
    demoteChannelToPublic,
    getBearerApiCompanionPin,
    setBearerApiCompanionPin,
    type BearerApiCompanionPinData,
    type ChannelDemotionNotice,
    type ChannelEnvelopeData,
    type ChannelEnvelopeLabel,
    type ChannelEnvelopeRow,
    type ChannelPrivacy,
    type ContactTrackingMode,
  } from '$lib/api/endpoints/channels';
  import { currentCompanionGardenScope } from '$lib/fleet/companion-scope';
  import {
    companionDisplayLabel,
    companionTechnicalLabel,
  } from '$lib/fleet/companion-display';

  // ── State ──
  let data = $state<ChannelEnvelopeData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let saveError = $state('');
  let saveMessage = $state('');
  let saving = $state(false);

  // Edit form state
  let editingChannelId = $state<string | null>(null);
  let formChannelId = $state('');
  let formPrivacy = $state<ChannelPrivacy>('invite_only');
  let formBroadcast = $state(false);
  let formContactTracking = $state<ContactTrackingMode>('auto');
  let formNeedsReview = $state(false);
  let showForm = $state(false);

  // Demotion (invite-only -> public) click-to-accept flow (jp36.6.2)
  let demotionNotice = $state<ChannelDemotionNotice | null>(null);
  let demotionChannelId = $state<string | null>(null);
  let demotionAcknowledged = $state(false);
  let demotionLoading = $state(false);

  // Companion Cluster: Bearer API pinned-companion control (vknn)
  let bearerPin = $state<BearerApiCompanionPinData | null>(null);
  let bearerPinSaving = $state(false);
  let bearerPinError = $state('');
  let bearerPinMessage = $state('');

  const SOURCE_LABELS: Record<ChannelEnvelopeRow['source'], string> = {
    channel_label: 'channel-owned',
    operator_confirmed: 'operator-confirmed',
    operator_override: 'override',
    derived_default: 'derived',
  };
  const channelSummary = $derived.by(() => ({
    total: data?.channels.length ?? 0,
    owned: data?.channels.filter((channel) => channel.hasLabel).length ?? 0,
    needsReview: data?.channels.filter((channel) => channel.needsReview).length ?? 0,
    epochs: data?.epochs.length ?? 0,
  }));

  function startCreate(): void {
    editingChannelId = null;
    formChannelId = '';
    formPrivacy = 'invite_only';
    formBroadcast = false;
    formContactTracking = 'auto';
    formNeedsReview = false;
    saveError = '';
    saveMessage = '';
    showForm = true;
  }

  function startEdit(row: ChannelEnvelopeRow): void {
    editingChannelId = row.channelId;
    formChannelId = row.channelId;
    formPrivacy = row.privacy;
    formBroadcast = row.broadcast;
    formContactTracking = row.contactTracking;
    formNeedsReview = row.needsReview;
    saveError = '';
    saveMessage = '';
    showForm = true;
  }

  function cancelEdit(): void {
    showForm = false;
    editingChannelId = null;
    saveError = '';
  }

  async function loadData(): Promise<void> {
    loading = true;
    error = '';
    try {
      data = await getChannelEnvelopeData();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load channel envelope data';
    } finally {
      loading = false;
    }
  }

  async function submitLabel(): Promise<void> {
    const channelId = formChannelId.trim();
    if (!channelId) {
      saveError = 'Channel id is required';
      return;
    }
    if (formBroadcast && formPrivacy !== 'public') {
      saveError = "A broadcast surface is always 'public' (contract rule)";
      return;
    }
    saving = true;
    saveError = '';
    saveMessage = '';
    const label: ChannelEnvelopeLabel = {
      privacy: formPrivacy,
      ...(formBroadcast ? { broadcast: true } : {}),
      contactTracking: formContactTracking,
      ...(formNeedsReview ? { needsReview: true } : {}),
    };
    try {
      const result = await saveChannelEnvelopeLabel(channelId, label);
      data = result.data;
      saveMessage = result.message;
      showForm = false;
      editingChannelId = null;
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to save channel label';
    } finally {
      saving = false;
    }
  }

  async function removeLabel(row: ChannelEnvelopeRow): Promise<void> {
    saving = true;
    saveError = '';
    saveMessage = '';
    try {
      const result = await saveChannelEnvelopeLabel(row.channelId, null);
      data = result.data;
      saveMessage = result.message;
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to remove channel label';
    } finally {
      saving = false;
    }
  }

  async function confirmReviewed(row: ChannelEnvelopeRow): Promise<void> {
    saving = true;
    saveError = '';
    saveMessage = '';
    const { needsReview: _needsReview, ...label } = row.label ?? { privacy: row.privacy };
    try {
      const result = await saveChannelEnvelopeLabel(row.channelId, label);
      data = result.data;
      saveMessage = `Review cleared for ${row.channelId}`;
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to clear review flag';
    } finally {
      saving = false;
    }
  }

  async function startDemotion(row: ChannelEnvelopeRow): Promise<void> {
    saveError = '';
    saveMessage = '';
    demotionAcknowledged = false;
    demotionNotice = null;
    demotionChannelId = row.channelId;
    demotionLoading = true;
    try {
      demotionNotice = await getChannelDemotionNotice(row.channelId);
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to load demotion notice';
      demotionChannelId = null;
    } finally {
      demotionLoading = false;
    }
  }

  function cancelDemotion(): void {
    demotionNotice = null;
    demotionChannelId = null;
    demotionAcknowledged = false;
  }

  async function acceptDemotion(): Promise<void> {
    if (!demotionNotice || !demotionAcknowledged) return;
    saving = true;
    saveError = '';
    saveMessage = '';
    try {
      const result = await demoteChannelToPublic(
        demotionNotice.channelId,
        demotionNotice.noticeVersion,
      );
      data = result.data;
      saveMessage = result.message;
      cancelDemotion();
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to demote channel';
    } finally {
      saving = false;
    }
  }

  async function loadBearerPin(): Promise<void> {
    bearerPinError = '';
    try {
      bearerPin = await getBearerApiCompanionPin();
    } catch (e) {
      bearerPinError = e instanceof Error ? e.message : 'Failed to load Bearer API pin';
    }
  }

  function requestBoundCompanionId(): string | null {
    const scopedCompanionId = currentCompanionGardenScope()?.companionId;
    if (scopedCompanionId) return scopedCompanionId;
    return bearerPin?.companions.length === 1
      ? (bearerPin.companions[0]?.companionId ?? null)
      : null;
  }

  async function submitBearerPin(): Promise<void> {
    const companionId = requestBoundCompanionId();
    if (!companionId) {
      bearerPinError = 'Open a companion Garden before changing the Bearer API pin';
      return;
    }
    bearerPinSaving = true;
    bearerPinError = '';
    bearerPinMessage = '';
    try {
      const result = await setBearerApiCompanionPin();
      bearerPin = result.data;
      bearerPinMessage = result.message;
    } catch (e) {
      bearerPinError = e instanceof Error ? e.message : 'Failed to pin the Bearer API companion';
    } finally {
      bearerPinSaving = false;
    }
  }

  onMount(() => {
    void loadData();
    void loadBearerPin();
  });
</script>

<svelte:head>
  <title>Channels · Garden</title>
</svelte:head>

<div class="garden-page space-y-6 pb-10">
  {#snippet channelActions()}
    <div class="garden-toolbar flex flex-wrap gap-2">
      <button
        onclick={startCreate}
        disabled={loading}
        class="garden-action garden-action--primary min-h-10 rounded-lg bg-gold-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gold-700 disabled:opacity-50"
      >
        Add channel label
      </button>
      <button
        onclick={loadData}
        disabled={loading}
        class="garden-action min-h-10 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm font-medium text-shadow-600 transition-colors hover:border-gold-300 hover:text-shadow-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  {/snippet}
  <GardenPageHeader
    eyebrow="Configure Garden · channels.json"
    title="Channels"
    description="Own privacy, broadcast, and contact-tracking labels for every inbound surface. Precedence remains channel label, operator override, then derived default."
    actions={channelActions}
  />

  {#if data}
    <section class="garden-metric-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Channel configuration summary">
      <article class="garden-metric card-garden p-4">
        <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Known surfaces</p>
        <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-shadow-900">{channelSummary.total}</p>
        <p class="mt-1 text-xs text-shadow-500">effective channel envelopes</p>
      </article>
      <article class="garden-metric card-garden p-4">
        <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Owned labels</p>
        <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-moss-700">{channelSummary.owned}</p>
        <p class="mt-1 text-xs text-shadow-500">explicitly stored in channels.json</p>
      </article>
      <article class="garden-metric card-garden p-4">
        <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Needs review</p>
        <p class="mt-2 font-serif text-3xl font-semibold tabular-nums {channelSummary.needsReview > 0 ? 'text-wilt-600' : 'text-shadow-900'}">{channelSummary.needsReview}</p>
        <p class="mt-1 text-xs text-shadow-500">fail-closed migration decisions</p>
      </article>
      <article class="garden-metric card-garden p-4">
        <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Disclosure epochs</p>
        <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-gold-700">{channelSummary.epochs}</p>
        <p class="mt-1 text-xs text-shadow-500">audited privacy demotions</p>
      </article>
    </section>
  {/if}

  <!-- Companion Cluster: Bearer API pinned companion (vknn) -->
  <section class="garden-section card-garden overflow-hidden">
    <div class="garden-section-header border-b border-bark-300 bg-bark-50 px-5 py-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
      <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Owner field · api.companionId</p>
      <h2 class="garden-section-title mt-1 text-base font-serif font-semibold text-shadow-900">
        Companion Cluster &mdash; Bearer API pinned companion
      </h2>
      <p class="garden-section-description mt-1 max-w-4xl text-sm text-shadow-600">
        The inbound OpenAI-compatible Bearer API is pinned to exactly one Companion Cluster member
        (channels.json <code class="font-mono">api.companionId</code>). Callers never select a
        companion per request. A change takes effect after a gateway restart.
      </p>
        </div>
        {#if bearerPin?.pinnedCompanionId}
          <span class="garden-status garden-status--success rounded-full border border-moss-300 bg-moss-50 px-2.5 py-1 text-xs font-medium text-moss-700">Pinned</span>
        {:else}
          <span class="garden-status garden-status--warning rounded-full border border-gold-300 bg-gold-50 px-2.5 py-1 text-xs font-medium text-gold-700">Default routing</span>
        {/if}
      </div>
    </div>
    <div class="space-y-3 p-5">
    {#if bearerPinError}
      <div class="garden-error rounded-lg border border-wilt-300 bg-wilt-50 p-3" role="alert">
        <p class="text-sm text-shadow-800">{bearerPinError}</p>
      </div>
    {/if}
    {#if bearerPinMessage}
      <div class="garden-status garden-status--success rounded-lg border border-moss-300 bg-moss-50 p-3" role="status">
        <p class="text-sm text-shadow-800">{bearerPinMessage}</p>
      </div>
    {/if}
    {#if bearerPin}
      {#if bearerPin.companions.length === 0}
        <p class="text-sm text-shadow-600">No registered companions are available to pin.</p>
      {:else}
        {@const gardenCompanionId = requestBoundCompanionId()}
        <div class="garden-field-grid grid gap-4 rounded-xl border border-bark-200 bg-bark-100 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div class="garden-field text-sm text-shadow-700">
            <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Active Garden scope</p>
            <p>This Garden: {companionDisplayLabel(bearerPin.companions, gardenCompanionId)}</p>
            {#if gardenCompanionId}
              <details class="mt-1 text-xs text-shadow-500">
                <summary class="cursor-pointer">Technical details</summary>
                <p class="mt-1 break-all font-mono">{companionTechnicalLabel(gardenCompanionId)}</p>
              </details>
            {/if}
          </div>
          <button
            onclick={submitBearerPin}
            disabled={bearerPinSaving || !gardenCompanionId || gardenCompanionId === bearerPin.pinnedCompanionId}
            class="garden-action garden-action--primary min-h-10 rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gold-700 disabled:opacity-50"
          >
            {bearerPinSaving ? 'Pinning...' : 'Pin this companion'}
          </button>
        </div>
        {#if bearerPin.pinnedCompanionId}
          <div class="text-xs text-shadow-500">
            <p>
              Currently pinned:
              {companionDisplayLabel(bearerPin.companions, bearerPin.pinnedCompanionId)}
            </p>
            <details class="mt-1">
              <summary class="cursor-pointer">Technical details</summary>
              <p class="mt-1 break-all font-mono">{companionTechnicalLabel(bearerPin.pinnedCompanionId)}</p>
            </details>
          </div>
        {:else}
          <p class="text-xs text-shadow-500">Currently pinned: none (single-companion default)</p>
        {/if}
      {/if}
    {/if}
    </div>
  </section>

  {#if saveMessage}
    <div class="garden-status garden-status--success rounded-xl border border-moss-300 bg-moss-50 p-3" role="status">
      <p class="text-sm text-shadow-800">{saveMessage}</p>
    </div>
  {/if}
  {#if saveError}
    <div class="garden-error rounded-xl border border-wilt-300 bg-wilt-50 p-3" role="alert">
      <p class="text-sm text-shadow-800">{saveError}</p>
    </div>
  {/if}

  <!-- Demotion (invite-only -> public) click-to-accept notice (jp36.6.2) -->
  {#if demotionNotice}
    <section class="garden-section card-garden space-y-4 border-l-4 border-l-petal-400 p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        Demote <code class="font-mono">{demotionNotice.channelId}</code>: invite-only &rarr; public
      </h2>
      {#if demotionNotice.demotable}
        <p class="text-sm text-shadow-800 leading-relaxed">{demotionNotice.notice}</p>
        <p class="text-xs text-shadow-500">Notice version {demotionNotice.noticeVersion}</p>
        <label class="flex items-start gap-2 text-sm text-shadow-800">
          <input type="checkbox" bind:checked={demotionAcknowledged} class="mt-1" />
          <span>I accept: this starts a fresh disclosure epoch and prior material is not retroactively declassified.</span>
        </label>
        <div class="flex gap-2">
          <button
            onclick={acceptDemotion}
            disabled={saving || !demotionAcknowledged}
            class="garden-action garden-action--danger text-sm px-4 py-1.5 rounded-lg bg-petal-200 text-shadow-900 hover:bg-petal-300
                   transition-colors disabled:opacity-50 font-medium"
          >
            {saving ? 'Applying...' : 'Accept and demote'}
          </button>
          <button
            onclick={cancelDemotion}
            disabled={saving}
            class="garden-action text-sm px-4 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                   hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
          >
            Cancel
          </button>
        </div>
      {:else}
        <p class="text-sm text-shadow-800">{demotionNotice.reason ?? 'This channel cannot be demoted.'}</p>
        <button
          onclick={cancelDemotion}
          class="garden-action text-sm px-4 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 font-medium"
        >
          Close
        </button>
      {/if}
    </section>
  {/if}

  {#if showForm}
    <section class="garden-section card-garden overflow-hidden">
      <div class="garden-section-header border-b border-bark-300 bg-bark-50 px-5 py-4">
      <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Channel owner record</p>
      <h2 class="garden-section-title mt-1 text-base font-serif font-semibold text-shadow-900">
        {editingChannelId ? `Edit label: ${editingChannelId}` : 'New channel label'}
      </h2>
      </div>
      <div class="space-y-4 p-5">
      <div class="garden-field-grid grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="garden-field block">
          <span class="text-xs font-medium text-shadow-600 uppercase tracking-wide">Channel id</span>
          <input
            type="text"
            bind:value={formChannelId}
            disabled={editingChannelId !== null}
            placeholder="discord:friends-room"
            class="mt-1 w-full text-sm rounded-lg border border-bark-300 px-3 py-2 disabled:opacity-60"
          />
        </label>
        <label class="garden-field block">
          <span class="text-xs font-medium text-shadow-600 uppercase tracking-wide">Privacy</span>
          <select
            bind:value={formPrivacy}
            class="mt-1 w-full text-sm rounded-lg border border-bark-300 px-3 py-2"
          >
            <option value="private">private</option>
            <option value="invite_only">invite_only</option>
            <option value="public">public</option>
          </select>
        </label>
        <label class="garden-field block">
          <span class="text-xs font-medium text-shadow-600 uppercase tracking-wide">Contact tracking</span>
          <select
            bind:value={formContactTracking}
            class="mt-1 w-full text-sm rounded-lg border border-bark-300 px-3 py-2"
          >
            <option value="auto">auto</option>
            <option value="approval">approval</option>
            <option value="role_gated">role_gated (reserved)</option>
          </select>
        </label>
        <div class="garden-field flex flex-col justify-end gap-3 rounded-xl border border-bark-200 bg-bark-100 p-3 sm:flex-row sm:items-center">
          <label class="flex items-center gap-2 text-sm text-shadow-700">
            <input type="checkbox" bind:checked={formBroadcast} />
            Broadcast surface (requires public)
          </label>
          <label class="flex items-center gap-2 text-sm text-shadow-700">
            <input type="checkbox" bind:checked={formNeedsReview} />
            Needs review
          </label>
        </div>
      </div>
      <div class="garden-toolbar flex flex-wrap gap-2">
        <button
          onclick={submitLabel}
          disabled={saving}
          class="garden-action garden-action--primary text-sm px-4 py-1.5 rounded-lg bg-gold-600 text-white hover:bg-gold-700
                 transition-colors disabled:opacity-50 font-medium"
        >
          {saving ? 'Saving...' : 'Save label'}
        </button>
        <button
          onclick={cancelEdit}
          disabled={saving}
          class="garden-action text-sm px-4 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                 hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
        >
          Cancel
        </button>
      </div>
      </div>
    </section>
  {/if}

  {#if loading}
    <div class="garden-loading card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading channel envelope data...</p>
    </div>
  {:else if error}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-6" role="alert">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if data}
    {#if data.channels.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No channel labels or overrides yet</p>
        <p class="text-sm text-shadow-600">
          Seed labels with <code class="font-mono">npm run migrate:channel-envelope</code> or add one above.
          Unlabeled channels classify by derived default (DM: private, otherwise invite_only).
        </p>
      </div>
    {:else}
      <section class="garden-section space-y-3" aria-labelledby="channel-labels-heading">
        <div class="garden-section-header flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Effective precedence</p>
            <h2 id="channel-labels-heading" class="garden-section-title font-serif text-xl font-semibold text-shadow-900">Channel labels</h2>
          </div>
          <p class="text-xs text-shadow-500">{channelSummary.owned} explicit of {channelSummary.total} known surfaces</p>
        </div>
      <div class="garden-table-shell card-garden hidden overflow-hidden md:block">
        <div class="garden-table-scroll overflow-x-auto">
        <table class="garden-table w-full text-sm">
          <thead>
            <tr class="text-left border-b border-bark-200 text-xs text-shadow-600 uppercase tracking-wide">
              <th class="px-4 py-3">Channel</th>
              <th class="px-4 py-3">Privacy</th>
              <th class="px-4 py-3">Broadcast</th>
              <th class="px-4 py-3">Contact tracking</th>
              <th class="px-4 py-3">Source</th>
              <th class="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.channels as row (row.channelId)}
              <tr class="border-b border-bark-100 hover:bg-bark-50">
                <td class="px-4 py-3 font-mono text-shadow-800">
                  {row.channelId}
                  {#if row.needsReview}
                    <span
                      class="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-wilt-100 text-wilt-600 border border-wilt-300"
                      title="Migration could not derive this channel's privacy unambiguously; it was seeded fail-closed as invite_only. Confirm or correct it."
                    >
                      &#9888; needs review
                    </span>
                  {/if}
                </td>
                <td class="px-4 py-3">
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-petal-100 text-petal-500">
                    {row.privacy}
                  </span>
                </td>
                <td class="px-4 py-3 text-shadow-700">{row.broadcast ? 'yes' : 'no'}</td>
                <td class="px-4 py-3 text-shadow-700">{row.contactTracking}</td>
                <td class="px-4 py-3">
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-700">
                    {SOURCE_LABELS[row.source]}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <div class="flex gap-2">
                    <button
                      onclick={() => startEdit(row)}
                      disabled={saving}
                      class="garden-action text-xs px-2 py-1 rounded border border-bark-300 text-shadow-600 hover:bg-bark-100 disabled:opacity-50"
                    >
                      {row.hasLabel ? 'Edit' : 'Add label'}
                    </button>
                    {#if row.needsReview && row.hasLabel}
                      <button
                        onclick={() => confirmReviewed(row)}
                        disabled={saving}
                        class="garden-action text-xs px-2 py-1 rounded border border-gold-300 text-shadow-700 bg-gold-100 hover:bg-gold-200 disabled:opacity-50"
                      >
                        Confirm reviewed
                      </button>
                    {/if}
                    {#if row.privacy === 'invite_only' && !row.broadcast}
                      <button
                        onclick={() => startDemotion(row)}
                        disabled={saving || demotionLoading}
                        title="Demote invite-only -> public (click-to-accept: starts a fresh disclosure epoch)"
                        class="garden-action garden-action--danger text-xs px-2 py-1 rounded border border-petal-300 text-petal-500 hover:bg-petal-100 disabled:opacity-50"
                      >
                        Demote to public
                      </button>
                    {/if}
                    {#if row.hasLabel}
                      <button
                        onclick={() => removeLabel(row)}
                        disabled={saving}
                        class="garden-action garden-action--danger text-xs px-2 py-1 rounded border border-wilt-300 text-wilt-600 hover:bg-wilt-100 disabled:opacity-50"
                      >
                        Remove label
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      </div>
      <div class="grid gap-3 md:hidden">
        {#each data.channels as row (row.channelId)}
          <article class="card-garden p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="break-all font-mono text-sm font-medium text-shadow-900">{row.channelId}</p>
                <p class="mt-1 text-xs text-shadow-500">{SOURCE_LABELS[row.source]} · {row.contactTracking} contact tracking</p>
              </div>
              <span class="rounded-full border border-petal-200 bg-petal-50 px-2 py-1 text-xs font-medium text-petal-600">{row.privacy}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2 text-xs">
              <span class="garden-status rounded-full border border-bark-300 bg-bark-100 px-2 py-1 text-shadow-600">Broadcast {row.broadcast ? 'on' : 'off'}</span>
              {#if row.needsReview}
                <span class="garden-status garden-status--danger rounded-full border border-wilt-300 bg-wilt-50 px-2 py-1 text-wilt-600">Needs review</span>
              {/if}
            </div>
            <div class="garden-toolbar mt-4 flex flex-wrap gap-2 border-t border-bark-200 pt-3">
              <button onclick={() => startEdit(row)} disabled={saving} class="garden-action rounded border border-bark-300 px-2 py-1 text-xs text-shadow-700 disabled:opacity-50">{row.hasLabel ? 'Edit' : 'Add label'}</button>
              {#if row.needsReview && row.hasLabel}
                <button onclick={() => confirmReviewed(row)} disabled={saving} class="garden-action rounded border border-gold-300 bg-gold-50 px-2 py-1 text-xs text-gold-700 disabled:opacity-50">Confirm reviewed</button>
              {/if}
              {#if row.privacy === 'invite_only' && !row.broadcast}
                <button onclick={() => startDemotion(row)} disabled={saving || demotionLoading} class="garden-action garden-action--danger rounded border border-petal-300 px-2 py-1 text-xs text-petal-600 disabled:opacity-50">Demote to public</button>
              {/if}
              {#if row.hasLabel}
                <button onclick={() => removeLabel(row)} disabled={saving} class="garden-action garden-action--danger rounded border border-wilt-300 px-2 py-1 text-xs text-wilt-600 disabled:opacity-50">Remove label</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
      </section>
    {/if}

    <!-- Informational: lower precedence tiers -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <section class="garden-section card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-900 mb-2">Operator prefix overrides (tier 2)</h2>
        {#if Object.keys(data.prefixOverrides).length === 0}
          <p class="text-sm text-shadow-600">None configured in trust-policy.json.</p>
        {:else}
          <ul class="text-sm text-shadow-700 space-y-1">
            {#each Object.entries(data.prefixOverrides) as [prefix, visibility] (prefix)}
              <li><code class="font-mono">{prefix}*</code> &rarr; {visibility}</li>
            {/each}
          </ul>
        {/if}
      </section>
      <section class="garden-section card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-900 mb-2">Derived-default prefix heuristics (tier 3, demoted)</h2>
        <p class="text-xs text-shadow-600 mb-2">
          Seed data for channel records; they apply only to channels without an owned label or override.
        </p>
        <ul class="text-sm text-shadow-700 space-y-1">
          {#each data.privatePrefixes as prefix (prefix)}
            <li><code class="font-mono">{prefix}*</code> &rarr; private</li>
          {/each}
          {#each data.broadcastPrefixes as prefix (prefix)}
            <li><code class="font-mono">{prefix}*</code> &rarr; public + broadcast</li>
          {/each}
        </ul>
      </section>
    </div>

    <!-- Classification epoch boundaries (jp36.6.2 demotion audit) -->
    <section class="garden-section card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-2">
        Classification epochs (invite-only &rarr; public demotions)
      </h2>
      {#if data.epochs.length === 0}
        <p class="text-sm text-shadow-600">
          No demotions recorded. Accepting an invite-only &rarr; public demotion stamps an
          operator-signed epoch boundary here; material generated before that boundary keeps the
          invite-only ceiling.
        </p>
      {:else}
        <ul class="text-sm text-shadow-700 space-y-1">
          {#each data.epochs as epoch (epoch.channelId + epoch.at)}
            <li>
              <code class="font-mono">{epoch.channelId}</code>
              &mdash; {epoch.from} &rarr; {epoch.to}
              at <span class="text-shadow-500">{epoch.at}</span>
              by {epoch.acceptedBy}
              <span class="text-shadow-400">(notice {epoch.noticeVersion})</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
