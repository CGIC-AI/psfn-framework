<script lang="ts">
  // Fleet lifecycle (h248l.6): plan, review, and apply companion add/remove
  // through the gateway's shared reconciler. Sequencing, fencing, idempotency,
  // and recovery live server-side; this view only collects metadata and
  // credential *references*, shows the plan, and echoes confirmations.
  import { onDestroy, onMount } from 'svelte';
  import type { FleetPortalProjection } from '$lib/fleet/portal';
  import {
    FLEET_LIFECYCLE_ERROR_HELP,
    FLEET_LIFECYCLE_STAGE_LABELS,
    FleetLifecycleRequestError,
    applyFleetLifecyclePlan,
    fetchFleetLifecycleListing,
    requestFleetLifecyclePlan,
    type FleetLifecycleListing,
  } from '$lib/fleet/lifecycle';
  import type {
    FleetLifecyclePlan,
    FleetLifecycleProgress,
  } from '../../../../../src/system/fleet-lifecycle/contracts.js';

  interface Props {
    projection: FleetPortalProjection;
  }

  let { projection }: Props = $props();

  let listing = $state<FleetLifecycleListing | null>(null);
  let reviewed = $state<FleetLifecyclePlan | null>(null);
  let confirmation = $state('');
  let busy = $state(false);
  let message = $state('');
  let controller: AbortController | null = null;

  let add = $state({
    companionId: '',
    displayName: '',
    companionDataDir: '',
    characterCardPath: '',
    postgresSchema: '',
    postgresRole: '',
    credentialEnvName: '',
    readmit: false,
  });
  let removeCompanionId = $state('');

  function explain(error: unknown): string {
    if (error instanceof FleetLifecycleRequestError) {
      const stage = error.stageId ? ` (stage ${error.stageId})` : '';
      return `${FLEET_LIFECYCLE_ERROR_HELP[error.code as keyof typeof FLEET_LIFECYCLE_ERROR_HELP] ?? error.code}${stage}`;
    }
    return error instanceof Error ? error.message : 'Lifecycle request failed';
  }

  async function refresh(): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      listing = await fetchFleetLifecycleListing(request.signal);
    } catch (error) {
      if (!request.signal.aborted) message = explain(error);
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    message = '';
    try {
      await action();
    } catch (error) {
      message = explain(error);
    } finally {
      busy = false;
      await refresh();
    }
  }

  function planAdd(): Promise<void> {
    return run(async () => {
      reviewed = await requestFleetLifecyclePlan({
        operation: 'add',
        companion: {
          companionId: add.companionId.trim(),
          companionDataDir: add.companionDataDir.trim(),
          characterCardPath: add.characterCardPath.trim(),
          postgresSchema: add.postgresSchema.trim(),
          postgresRole: add.postgresRole.trim(),
          postgresDatabaseUrlRef: { kind: 'env', envName: add.credentialEnvName.trim() },
          ...(add.displayName.trim() ? { displayName: add.displayName.trim() } : {}),
        },
        ...(add.readmit ? { readmit: { confirmCompanionId: add.companionId.trim() } } : {}),
      });
      confirmation = '';
    });
  }

  function planRemove(): Promise<void> {
    return run(async () => {
      reviewed = await requestFleetLifecyclePlan({
        operation: 'remove',
        companionId: removeCompanionId,
        confirmCompanionId: removeCompanionId,
      });
      confirmation = '';
    });
  }

  function apply(plan: FleetLifecyclePlan, resume: boolean): Promise<void> {
    return run(async () => {
      const progress: FleetLifecycleProgress = await applyFleetLifecyclePlan({
        plan,
        confirmCompanionId: confirmation.trim(),
        resume,
      });
      message = progress.status === 'applied'
        ? 'Plan applied. Restart or upgrade the deployment so the new roster takes effect.'
        : `Plan is ${progress.status}.`;
      reviewed = null;
      confirmation = '';
    });
  }

  function statusClass(status: string): string {
    if (status === 'applied') return 'text-moss-700';
    if (status === 'failed') return 'text-wilt-700';
    return 'text-gold-700';
  }

  onMount(() => { void refresh(); });
  onDestroy(() => { controller?.abort(); });
</script>

<section class="garden-section space-y-4" aria-labelledby="fleet-lifecycle-heading">
  <div class="card-garden p-4">
    <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Fleet membership</p>
    <h2 id="fleet-lifecycle-heading" class="font-serif text-xl font-semibold text-shadow-900">Add or remove companions</h2>
    <p class="mt-1 text-sm text-shadow-600">
      Every change is a reviewed plan applied by the shared lifecycle reconciler. Removal retains the
      companion's schema, data, workspace, and backups; purging is a separate workflow. Credentials are
      named by environment reference only.
    </p>
    {#if listing?.applyMode === 'cli_only'}
      <p class="mt-2 text-sm text-gold-700">This deployment applies plans through the CLI; plans and progress are shown here.</p>
    {/if}
    {#if message}
      <p class="mt-2 text-sm text-shadow-800" role="status">{message}</p>
    {/if}
  </div>

  <div class="grid gap-4 lg:grid-cols-2">
    <form class="card-garden space-y-2 p-4" onsubmit={(event) => { event.preventDefault(); void planAdd(); }}>
      <h3 class="font-semibold text-shadow-900">Plan an add</h3>
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Companion ID (UUID)" bind:value={add.companionId} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Display name (optional)" bind:value={add.displayName} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Companion data dir (relative)" bind:value={add.companionDataDir} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Character card path (relative)" bind:value={add.characterCardPath} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Postgres schema" bind:value={add.postgresSchema} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Postgres runtime role" bind:value={add.postgresRole} autocomplete="off" />
      <input class="w-full rounded border border-bark-300 px-2 py-1 text-sm" placeholder="Database URL env reference (e.g. COMPANION_X_DATABASE_URL)" bind:value={add.credentialEnvName} autocomplete="off" />
      <label class="flex items-center gap-2 text-sm text-shadow-700">
        <input type="checkbox" bind:checked={add.readmit} /> Re-adding a previously removed companion (after fleet-auth reapproval)
      </label>
      <button type="submit" class="garden-action rounded-lg border border-bark-300 px-3 py-1.5 text-sm" disabled={busy}>Plan add</button>
    </form>

    <form class="card-garden space-y-2 p-4" onsubmit={(event) => { event.preventDefault(); void planRemove(); }}>
      <h3 class="font-semibold text-shadow-900">Plan a removal</h3>
      <select class="w-full rounded border border-bark-300 px-2 py-1 text-sm" bind:value={removeCompanionId}>
        <option value="">Choose a companion</option>
        {#each projection.companions as companion (companion.companionId)}
          <option value={companion.companionId}>{companion.displayName}</option>
        {/each}
      </select>
      <p class="text-xs text-shadow-500">Removal fences ICP first and retains all data.</p>
      <button type="submit" class="garden-action rounded-lg border border-bark-300 px-3 py-1.5 text-sm" disabled={busy || !removeCompanionId}>Plan removal</button>
    </form>
  </div>

  {#if reviewed}
    <div class="card-garden p-4" aria-label="Plan review">
      <h3 class="font-semibold text-shadow-900">Review plan · {reviewed.operation} {reviewed.companionId}</h3>
      <ol class="mt-2 list-decimal pl-5 text-sm text-shadow-700">
        {#each reviewed.stages as stage (stage)}
          <li>{FLEET_LIFECYCLE_STAGE_LABELS[stage]}</li>
        {/each}
      </ol>
      {#if reviewed.retention}
        <p class="mt-2 text-sm text-shadow-700">
          Retained: schema {reviewed.retention.postgresSchema}, data {reviewed.retention.companionDataDir}, workspace, backups.
        </p>
      {/if}
      <p class="mt-2 break-all font-mono text-xs text-shadow-500">Plan digest {reviewed.digest}</p>
      <label class="mt-3 block text-sm text-shadow-700">
        Type the companion ID to confirm
        <input class="mt-1 w-full rounded border border-bark-300 px-2 py-1 font-mono text-sm" bind:value={confirmation} autocomplete="off" />
      </label>
      <button
        type="button"
        class="garden-action garden-action--primary mt-3 rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        disabled={busy || confirmation.trim() !== reviewed.companionId || listing?.applyMode !== 'local'}
        onclick={() => reviewed && void apply(reviewed, false)}
      >Apply plan</button>
    </div>
  {/if}

  <div class="card-garden p-4">
    <h3 class="font-semibold text-shadow-900">Plans</h3>
    {#if !reviewed}
      <label class="mt-2 block text-xs text-shadow-600">
        Companion ID confirmation for resume
        <input class="mt-1 w-full rounded border border-bark-300 px-2 py-1 font-mono text-sm" bind:value={confirmation} autocomplete="off" />
      </label>
    {/if}
    {#if !listing}
      <p class="mt-2 text-sm text-shadow-600">Loading plans…</p>
    {:else if listing.plans.length === 0}
      <p class="mt-2 text-sm text-shadow-600">No lifecycle plans yet.</p>
    {:else}
      <ul class="mt-2 space-y-3">
        {#each listing.plans as progress (progress.plan.planId)}
          <li class="border-t border-bark-200 pt-2 text-sm">
            <p>
              <span class="font-medium">{progress.plan.operation}</span>
              <span class="font-mono text-xs">{progress.plan.companionId}</span>
              · <span class={statusClass(progress.status)}>{progress.status}</span>
              · {new Date(progress.plan.createdAt).toLocaleString()}
            </p>
            <p class="text-xs text-shadow-500">
              {progress.receipts.length}/{progress.plan.stages.length} stages complete
            </p>
            {#if progress.failure}
              <p class="text-xs text-wilt-700">
                Failed at {FLEET_LIFECYCLE_STAGE_LABELS[progress.failure.stageId]}:
                {FLEET_LIFECYCLE_ERROR_HELP[progress.failure.code] ?? progress.failure.code}
              </p>
            {/if}
            {#if progress.status === 'failed' || progress.status === 'in_progress'}
              <button
                type="button"
                class="garden-action mt-1 rounded border border-bark-300 px-2 py-1 text-xs disabled:opacity-50"
                disabled={busy || confirmation.trim() !== progress.plan.companionId || listing.applyMode !== 'local'}
                onclick={() => void apply(progress.plan, true)}
              >Resume</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
