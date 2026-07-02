<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getChannelEnvelopeData,
    saveChannelEnvelopeLabel,
    type ChannelEnvelopeData,
    type ChannelEnvelopeLabel,
    type ChannelEnvelopeRow,
    type ChannelPrivacy,
    type ContactTrackingMode,
  } from '$lib/api/endpoints/channels';

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

  const SOURCE_LABELS: Record<ChannelEnvelopeRow['source'], string> = {
    channel_label: 'channel-owned',
    operator_override: 'override',
    derived_default: 'derived',
  };

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
    const label: ChannelEnvelopeLabel = {
      ...(row.label ?? { privacy: row.privacy }),
    };
    delete label.needsReview;
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

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Channels</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Context Envelope labels -- channel-owned privacy, broadcast flag, and contact tracking
        (channel label &gt; operator override &gt; derived default)
      </p>
    </div>
    <div class="flex gap-2">
      <button
        onclick={startCreate}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
               bg-gold-100 text-shadow-800 hover:bg-gold-200
               transition-colors disabled:opacity-50 font-medium"
      >
        Add channel label
      </button>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
               text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if saveMessage}
    <div class="card-garden p-3 border-l-4 border-l-gold-400">
      <p class="text-sm text-shadow-800">{saveMessage}</p>
    </div>
  {/if}
  {#if saveError}
    <div class="card-garden p-3 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{saveError}</p>
    </div>
  {/if}

  {#if showForm}
    <div class="card-garden p-5 space-y-4">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        {editingChannelId ? `Edit label: ${editingChannelId}` : 'New channel label'}
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="block">
          <span class="text-xs font-medium text-shadow-600 uppercase tracking-wide">Channel id</span>
          <input
            type="text"
            bind:value={formChannelId}
            disabled={editingChannelId !== null}
            placeholder="discord:friends-room"
            class="mt-1 w-full text-sm rounded-lg border border-bark-300 px-3 py-2 disabled:opacity-60"
          />
        </label>
        <label class="block">
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
        <label class="block">
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
        <div class="flex items-end gap-6 pb-2">
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
      <div class="flex gap-2">
        <button
          onclick={submitLabel}
          disabled={saving}
          class="text-sm px-4 py-1.5 rounded-lg bg-gold-200 text-shadow-900 hover:bg-gold-300
                 transition-colors disabled:opacity-50 font-medium"
        >
          {saving ? 'Saving...' : 'Save label'}
        </button>
        <button
          onclick={cancelEdit}
          disabled={saving}
          class="text-sm px-4 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                 hover:bg-bark-100 transition-colors disabled:opacity-50 font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading channel envelope data...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if data}
    {#if data.channels.length === 0}
      <div class="card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No channel labels or overrides yet</p>
        <p class="text-sm text-shadow-600">
          Seed labels with <code class="font-mono">npm run migrate:channel-envelope</code> or add one above.
          Unlabeled channels classify by derived default (DM: private, otherwise invite_only).
        </p>
      </div>
    {:else}
      <div class="card-garden overflow-x-auto">
        <table class="w-full text-sm">
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
                      class="text-xs px-2 py-1 rounded border border-bark-300 text-shadow-600 hover:bg-bark-100 disabled:opacity-50"
                    >
                      {row.hasLabel ? 'Edit' : 'Add label'}
                    </button>
                    {#if row.needsReview && row.hasLabel}
                      <button
                        onclick={() => confirmReviewed(row)}
                        disabled={saving}
                        class="text-xs px-2 py-1 rounded border border-gold-300 text-shadow-700 bg-gold-100 hover:bg-gold-200 disabled:opacity-50"
                      >
                        Confirm reviewed
                      </button>
                    {/if}
                    {#if row.hasLabel}
                      <button
                        onclick={() => removeLabel(row)}
                        disabled={saving}
                        class="text-xs px-2 py-1 rounded border border-wilt-300 text-wilt-600 hover:bg-wilt-100 disabled:opacity-50"
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
    {/if}

    <!-- Informational: lower precedence tiers -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card-garden p-5">
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
      </div>
      <div class="card-garden p-5">
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
      </div>
    </div>
  {/if}
</div>
