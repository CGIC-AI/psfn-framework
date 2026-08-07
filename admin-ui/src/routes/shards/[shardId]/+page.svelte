<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { ApiError } from '$lib/api/client';
  import {
    getShardConfiguration,
    getShardFoldReview,
    resolveShardFoldReview,
    updateShardConfiguration,
  } from '$lib/api/endpoints/shards';
  import {
    companionDisplayLabel,
    companionTechnicalLabel,
  } from '$lib/fleet/companion-display';
  import {
    fetchFleetPortalProjection,
    type FleetPortalCompanion,
  } from '$lib/fleet/portal';
  import type { ShardFoldReviewRecord } from '../../../../../src/faculties/shards/fold-review.js';
  import type { ShardConfigurationSnapshot } from '../../../../../src/faculties/shards/types.js';

  const shardId = $derived($page.params.shardId ?? '');
  let snapshot = $state<ShardConfigurationSnapshot | null>(null);
  let review = $state<ShardFoldReviewRecord | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let resolvingReview = $state(false);
  let snapshotUnavailable = $state(false);
  let error = $state('');
  let notice = $state('');
  let selectedModel = $state('');
  let maxTurns = $state(1);
  let maxOutputTokens = $state(1);
  let maxChargeUnits = $state(0);
  let reviewNote = $state('');
  let displayCompanions = $state<readonly FleetPortalCompanion[]>([]);

  function selectionKey(provider: string, model: string): string {
    return `${provider}::${model}`;
  }

  function syncForm(next: ShardConfigurationSnapshot): void {
    selectedModel = selectionKey(next.effective.model.provider, next.effective.model.model);
    maxTurns = next.effective.workerBudget.maxTurns;
    maxOutputTokens = next.effective.workerBudget.maxOutputTokens;
    maxChargeUnits = next.effective.workerBudget.maxChargeUnits;
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    const [configurationResult, reviewResult, projectionResult] = await Promise.allSettled([
      getShardConfiguration(shardId),
      getShardFoldReview(shardId),
      fetchFleetPortalProjection(),
    ]);
    if (configurationResult.status === 'fulfilled') {
      snapshot = configurationResult.value;
      syncForm(configurationResult.value);
    } else if (
      configurationResult.reason instanceof ApiError
      && configurationResult.reason.status === 404
    ) {
      snapshotUnavailable = true;
    } else {
      error = configurationResult.reason instanceof Error
        ? configurationResult.reason.message
        : 'Failed to load shard configuration';
    }

    if (reviewResult.status === 'fulfilled') {
      review = reviewResult.value;
    } else if (!(reviewResult.reason instanceof ApiError && reviewResult.reason.status === 404)) {
      error ||= reviewResult.reason instanceof Error
        ? reviewResult.reason.message
        : 'Failed to load shard fold review';
    }
    if (projectionResult.status === 'fulfilled') {
      displayCompanions = projectionResult.value.companions;
    }
    loading = false;
  }

  async function saveOverride(): Promise<void> {
    if (!snapshot) return;
    const selected = snapshot.allowed.models.find(model => (
      selectionKey(model.provider, model.model) === selectedModel
    ));
    if (!selected) {
      error = 'Select a parent-eligible model';
      return;
    }
    saving = true;
    error = '';
    notice = '';
    try {
      const next = await updateShardConfiguration(shardId, {
        model: {
          provider: selected.provider,
          model: selected.model,
        },
        workerBudget: {
          maxTurns,
          maxOutputTokens,
          maxChargeUnits,
        },
      });
      snapshot = next;
      syncForm(next);
      notice = 'Ephemeral shard override applied.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to update shard configuration';
    } finally {
      saving = false;
    }
  }

  async function resetOverride(): Promise<void> {
    saving = true;
    error = '';
    notice = '';
    try {
      const next = await updateShardConfiguration(shardId, {
        model: null,
        workerBudget: null,
      });
      snapshot = next;
      syncForm(next);
      notice = 'Shard returned to its inherited model and worker budget.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to reset shard configuration';
    } finally {
      saving = false;
    }
  }

  async function decideReview(decision: 'approve' | 'deny'): Promise<void> {
    resolvingReview = true;
    error = '';
    notice = '';
    try {
      const result = await resolveShardFoldReview(shardId, decision, reviewNote);
      if (!result.ok || !result.review) {
        throw new Error(result.message ?? 'Failed to resolve shard fold review');
      }
      review = result.review;
      notice = `Fold review ${decision === 'approve' ? 'approved' : 'denied'}.`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to resolve shard fold review';
    } finally {
      resolvingReview = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="space-y-6">
  <nav class="text-sm text-shadow-600" aria-label="Shard breadcrumb">
    <a href={`${base}/shards`} class="hover:text-gold-700">Shards</a>
    <span class="px-2">/</span>
    <span class="font-mono text-shadow-800">{shardId}</span>
  </nav>

  <header>
    <p class="text-sm uppercase tracking-wide text-shadow-500">Parent-owned shard subview</p>
    <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">{shardId}</h1>
    <p class="mt-1 text-sm text-shadow-600">
      Runtime-only overrides. Canonical owner files and shard authority remain unchanged.
    </p>
  </header>

  {#if error}
    <div class="rounded-xl border border-wilt-200 bg-wilt-50 p-4 text-sm text-wilt-700">{error}</div>
  {/if}
  {#if notice}
    <div class="rounded-xl border border-moss-200 bg-moss-50 p-4 text-sm text-moss-700">{notice}</div>
  {/if}

  {#if loading}
    <div class="card-garden p-8 text-center text-shadow-600">Loading parent-scoped shard state...</div>
  {:else}
    {#if snapshot}
      <section class="card-garden p-5" aria-labelledby="configuration-heading">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="configuration-heading" class="text-lg font-serif font-semibold text-shadow-900">
              Configuration snapshot
            </h2>
            <p class="mt-1 text-sm text-shadow-600">
              Source revision <span class="font-mono">{snapshot.source.revision.slice(0, 12)}</span>
              · {snapshot.lifecycleState} / {snapshot.health}
            </p>
          </div>
          <div class="rounded-lg bg-bark-100 px-3 py-2 text-sm text-shadow-700">
            <p>Parent {companionDisplayLabel(displayCompanions, snapshot.parentCompanionId)}</p>
            <details class="mt-1 text-xs text-shadow-500">
              <summary class="cursor-pointer">Technical details</summary>
              <p class="mt-1 break-all font-mono">{companionTechnicalLabel(snapshot.parentCompanionId)}</p>
            </details>
          </div>
        </div>

        <div class="mt-5 grid gap-4 lg:grid-cols-3">
          <div class="rounded-xl border border-bark-200 p-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-shadow-500">Inherited</h3>
            <dl class="mt-3 space-y-2 text-sm">
              <div><dt class="text-shadow-500">Model</dt><dd class="font-mono text-shadow-800">{snapshot.inherited.model.provider}/{snapshot.inherited.model.model}</dd></div>
              <div><dt class="text-shadow-500">Turns</dt><dd>{snapshot.inherited.workerBudget.maxTurns}</dd></div>
              <div><dt class="text-shadow-500">Output tokens</dt><dd>{snapshot.inherited.workerBudget.maxOutputTokens}</dd></div>
              <div><dt class="text-shadow-500">Charge units</dt><dd>{snapshot.inherited.workerBudget.maxChargeUnits}</dd></div>
            </dl>
          </div>
          <div class="rounded-xl border border-gold-200 bg-gold-50 p-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-gold-700">Override</h3>
            <dl class="mt-3 space-y-2 text-sm">
              <div><dt class="text-shadow-500">Model</dt><dd class="font-mono text-shadow-800">{snapshot.override.model ? `${snapshot.override.model.provider}/${snapshot.override.model.model}` : 'none'}</dd></div>
              <div><dt class="text-shadow-500">Turns</dt><dd>{snapshot.override.workerBudget.maxTurns ?? 'none'}</dd></div>
              <div><dt class="text-shadow-500">Output tokens</dt><dd>{snapshot.override.workerBudget.maxOutputTokens ?? 'none'}</dd></div>
              <div><dt class="text-shadow-500">Charge units</dt><dd>{snapshot.override.workerBudget.maxChargeUnits ?? 'none'}</dd></div>
            </dl>
          </div>
          <div class="rounded-xl border border-moss-200 bg-moss-50 p-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-moss-700">Effective</h3>
            <dl class="mt-3 space-y-2 text-sm">
              <div><dt class="text-shadow-500">Model</dt><dd class="font-mono text-shadow-800">{snapshot.effective.model.provider}/{snapshot.effective.model.model}</dd></div>
              <div><dt class="text-shadow-500">Turns</dt><dd>{snapshot.effective.workerBudget.maxTurns}</dd></div>
              <div><dt class="text-shadow-500">Output tokens</dt><dd>{snapshot.effective.workerBudget.maxOutputTokens}</dd></div>
              <div><dt class="text-shadow-500">Charge units</dt><dd>{snapshot.effective.workerBudget.maxChargeUnits}</dd></div>
            </dl>
          </div>
        </div>

        <form class="mt-6 space-y-4 border-t border-bark-200 pt-5" onsubmit={(event) => { event.preventDefault(); void saveOverride(); }}>
          <h3 class="font-medium text-shadow-900">Limited overrides</h3>
          <div class="grid gap-4 md:grid-cols-2">
            <label class="text-sm text-shadow-700">
              Parent-eligible model
              <select bind:value={selectedModel} class="mt-1 w-full rounded-lg border border-bark-300 bg-white px-3 py-2">
                {#each snapshot.allowed.models as model}
                  <option value={selectionKey(model.provider, model.model)}>
                    {model.provider}/{model.model}
                  </option>
                {/each}
              </select>
            </label>
            <label class="text-sm text-shadow-700">
              Maximum turns
              <input bind:value={maxTurns} type="number" min="1" max={snapshot.allowed.workerBudget.maxTurns} class="mt-1 w-full rounded-lg border border-bark-300 px-3 py-2" />
            </label>
            <label class="text-sm text-shadow-700">
              Maximum output tokens
              <input bind:value={maxOutputTokens} type="number" min="1" max={snapshot.allowed.workerBudget.maxOutputTokens} class="mt-1 w-full rounded-lg border border-bark-300 px-3 py-2" />
            </label>
            <label class="text-sm text-shadow-700">
              Maximum charge units
              <input bind:value={maxChargeUnits} type="number" min="0" max={snapshot.allowed.workerBudget.maxChargeUnits} step="0.25" class="mt-1 w-full rounded-lg border border-bark-300 px-3 py-2" />
            </label>
          </div>
          <div class="flex flex-wrap gap-3">
            <button disabled={saving} class="rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {saving ? 'Applying...' : 'Apply bounded override'}
            </button>
            <button type="button" disabled={saving} onclick={() => void resetOverride()} class="rounded-lg border border-bark-300 px-4 py-2 text-sm text-shadow-700 disabled:opacity-50">
              Reset to inherited
            </button>
          </div>
        </form>
      </section>

      <section class="card-garden p-5" aria-labelledby="readonly-heading">
        <h2 id="readonly-heading" class="text-lg font-serif font-semibold text-shadow-900">Inherited authority (read-only)</h2>
        <p class="mt-1 text-sm text-shadow-600">These fields have no override parser or mutation control.</p>
        <dl class="mt-4 grid gap-4 text-sm md:grid-cols-2">
          <div><dt class="text-shadow-500">Capability tier</dt><dd>{snapshot.effective.readOnly.capabilityTier.parent} → {snapshot.effective.readOnly.capabilityTier.effective}</dd></div>
          <div><dt class="text-shadow-500">Trust</dt><dd>{snapshot.effective.readOnly.trust.source}</dd></div>
          <div><dt class="text-shadow-500">Identity</dt><dd class="font-mono break-all">{snapshot.effective.readOnly.identity.shardCompanionId}</dd></div>
          <div><dt class="text-shadow-500">Prompts</dt><dd>{snapshot.effective.readOnly.prompts.source}</dd></div>
          <div><dt class="text-shadow-500">Capability owner version</dt><dd class="font-mono break-all">{snapshot.source.capabilityOwnerVersion}</dd></div>
          <div><dt class="text-shadow-500">Grant digest</dt><dd class="font-mono break-all">{snapshot.source.grantDigest}</dd></div>
          <div class="md:col-span-2"><dt class="text-shadow-500">Denial mask</dt><dd class="font-mono break-words">{snapshot.effective.readOnly.capabilityGrant.denialMask.join(', ')}</dd></div>
        </dl>
      </section>

      <section class="card-garden p-5" aria-labelledby="lineage-heading">
        <h2 id="lineage-heading" class="text-lg font-serif font-semibold text-shadow-900">Lineage</h2>
        <dl class="mt-4 grid gap-4 text-sm md:grid-cols-2">
          <div>
            <dt class="text-shadow-500">Parent companion</dt>
            <dd>{companionDisplayLabel(displayCompanions, snapshot.lineage.companionProvenance.parentCompanionId)}</dd>
            <details class="mt-1 text-xs text-shadow-500">
              <summary class="cursor-pointer">Technical details</summary>
              <p class="mt-1 break-all font-mono">{companionTechnicalLabel(snapshot.lineage.companionProvenance.parentCompanionId)}</p>
            </details>
          </div>
          <div><dt class="text-shadow-500">Shard companion</dt><dd class="font-mono break-all">{snapshot.lineage.shardCompanionId}</dd></div>
          <div><dt class="text-shadow-500">Source channel</dt><dd class="font-mono break-all">{snapshot.lineage.sourceMessage.channelId}</dd></div>
          <div><dt class="text-shadow-500">Creation mode</dt><dd>{snapshot.lineage.kind}</dd></div>
        </dl>
      </section>
    {:else if snapshotUnavailable}
      <div class="card-garden border-l-4 border-l-bark-300 p-5">
        <h2 class="font-serif text-lg font-semibold text-shadow-900">Runtime configuration unavailable</h2>
        <p class="mt-1 text-sm text-shadow-600">
          This shard is completed, failed, cleaned up, unknown, or outside the selected parent.
          Runtime overrides are denied.
        </p>
      </div>
    {/if}

    {#if review}
      <section class="card-garden p-5" aria-labelledby="fold-review-heading">
        <div class="flex items-center justify-between gap-3">
          <h2 id="fold-review-heading" class="text-lg font-serif font-semibold text-shadow-900">Fold review</h2>
          <span class="rounded-full bg-bark-100 px-3 py-1 text-sm text-shadow-700">{review.reviewState}</span>
        </div>
        <p class="mt-2 text-sm text-shadow-700">{review.task}</p>
        <p class="mt-2 text-sm text-shadow-600">
          {review.memoryItems.length} memory candidate(s) · {review.artifactItems.length} artifact(s)
        </p>
        {#if review.reviewState === 'pending' || review.reviewState === 'blocked'}
          <label class="mt-4 block text-sm text-shadow-700">
            Review note
            <textarea bind:value={reviewNote} rows="3" class="mt-1 w-full rounded-lg border border-bark-300 px-3 py-2"></textarea>
          </label>
          <div class="mt-3 flex gap-3">
            <button disabled={resolvingReview} onclick={() => void decideReview('approve')} class="rounded-lg bg-moss-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Approve fold</button>
            <button disabled={resolvingReview} onclick={() => void decideReview('deny')} class="rounded-lg bg-wilt-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Deny fold</button>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>
