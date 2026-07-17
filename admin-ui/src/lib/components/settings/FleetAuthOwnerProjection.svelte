<script lang="ts">
  import type { EffectiveFleetAuthOwnerProjection } from '$lib/types';
  import { settingsSimpleSectionAnchorId } from './navigation';

  let { projection } = $props<{
    projection: EffectiveFleetAuthOwnerProjection | null;
  }>();

  function statusLabel(status: EffectiveFleetAuthOwnerProjection['status']): string {
    switch (status) {
      case 'healthy': return 'Loaded and aligned';
      case 'restart_required': return 'Restart required';
      case 'off': return 'Feature off';
      case 'unavailable': return 'Unavailable';
    }
  }

  function statusClass(status: EffectiveFleetAuthOwnerProjection['status']): string {
    switch (status) {
      case 'healthy': return 'border-moss-300 bg-moss-50 text-moss-700';
      case 'restart_required': return 'border-gold-300 bg-gold-100 text-gold-700';
      case 'off': return 'border-bark-300 bg-bark-100 text-shadow-600';
      case 'unavailable': return 'border-wilt-400 bg-wilt-50 text-wilt-600';
    }
  }
</script>

<section
  id={settingsSimpleSectionAnchorId('advanced-fleet-auth')}
  data-settings-section="advanced-fleet-auth"
>
  <div class="card-garden p-5 space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">System owner · Read-only</p>
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Fleet Authentication</h2>
        <p class="text-sm text-shadow-600">
          Effective startup state compared with the freshly parsed canonical
          <code class="font-mono">fleet-auth.json</code> owner file.
        </p>
      </div>
      {#if projection}
        <span class="rounded-full border px-3 py-1 text-xs font-semibold {statusClass(projection.status)}">
          {statusLabel(projection.status)}
        </span>
      {/if}
    </div>

    {#if !projection}
      <div class="rounded-lg border border-wilt-400 bg-wilt-50 p-3 text-sm text-wilt-600">
        Fleet-auth owner state is unavailable from this Garden runtime.
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
        <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
          <p class="text-xs uppercase tracking-wide text-shadow-500">Feature</p>
          <p class="mt-1 font-medium text-shadow-800">{projection.featureState}</p>
        </div>
        <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
          <p class="text-xs uppercase tracking-wide text-shadow-500">Restart</p>
          <p class="mt-1 font-medium text-shadow-800">{projection.restartStatus.replaceAll('_', ' ')}</p>
        </div>
        <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
          <p class="text-xs uppercase tracking-wide text-shadow-500">Authority</p>
          <p class="mt-1 font-medium text-shadow-800">Canonical owner file only</p>
        </div>
      </div>

      {#if projection.restartStatus === 'blocked' || projection.restartStatus === 'unknown'}
        <div class="rounded-lg border border-wilt-400 bg-wilt-50 p-3 text-sm text-wilt-600">
          A safe restart decision cannot be made from the current owner state. Repair the canonical
          owner file or startup projection before restarting.
        </div>
      {/if}

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="min-w-0 rounded-lg border border-bark-300 bg-bark-50 p-4 space-y-3">
          <div>
            <p class="text-xs uppercase tracking-wide text-shadow-500">Effective at startup</p>
            <p class="text-sm font-medium text-shadow-800">{projection.effective.state}</p>
          </div>
          {#if projection.effective.state === 'loaded'}
            <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-shadow-500">Canonical origin</dt>
                <dd class="break-all font-mono text-shadow-700">{projection.effective.value.canonicalOrigin.value}</dd>
              </div>
              <div>
                <dt class="text-shadow-500">Activation generation</dt>
                <dd class="font-mono text-shadow-700">{projection.effective.revision.activationGeneration}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-shadow-500">Canonical revision (SHA-256)</dt>
                <dd class="break-all font-mono text-xs text-shadow-700">{projection.effective.revision.canonicalSha256}</dd>
              </div>
            </dl>
            <details class="rounded-md border border-bark-300 bg-white/50 p-3">
              <summary class="cursor-pointer text-sm font-medium text-shadow-700">Bounded effective policy</summary>
              <pre class="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-shadow-700">{JSON.stringify(projection.effective.value, null, 2)}</pre>
            </details>
          {:else}
            <p class="text-sm text-shadow-600">{projection.effective.detail}</p>
          {/if}
        </div>

        <div class="min-w-0 rounded-lg border border-bark-300 bg-bark-50 p-4 space-y-3">
          <div>
            <p class="text-xs uppercase tracking-wide text-shadow-500">On disk now</p>
            <p class="text-sm font-medium text-shadow-800">{projection.onDisk.state}</p>
          </div>
          {#if projection.onDisk.state === 'loaded'}
            <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-shadow-500">Canonical origin</dt>
                <dd class="break-all font-mono text-shadow-700">{projection.onDisk.value.canonicalOrigin.value}</dd>
              </div>
              <div>
                <dt class="text-shadow-500">Activation generation</dt>
                <dd class="font-mono text-shadow-700">{projection.onDisk.revision.activationGeneration}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-shadow-500">Canonical revision (SHA-256)</dt>
                <dd class="break-all font-mono text-xs text-shadow-700">{projection.onDisk.revision.canonicalSha256}</dd>
              </div>
            </dl>
            <details class="rounded-md border border-bark-300 bg-white/50 p-3">
              <summary class="cursor-pointer text-sm font-medium text-shadow-700">Bounded on-disk policy</summary>
              <pre class="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-shadow-700">{JSON.stringify(projection.onDisk.value, null, 2)}</pre>
            </details>
          {:else}
            <p class="text-sm text-shadow-600">{projection.onDisk.detail}</p>
          {/if}
        </div>
      </div>

      <div class="rounded-lg border border-bark-300 bg-bark-50 p-4 text-sm text-shadow-600">
        <p class="font-medium text-shadow-700">Intentionally omitted from Garden</p>
        <p class="mt-1">{projection.access.omittedCategories.join(' · ')}</p>
        <p class="mt-2">
          This surface has no editable fields. Unsupported security fields remain owner-file-only and
          no provider credential, subject, key bytes, recovery material, or private Discord topology is serialized.
        </p>
      </div>
    {/if}
  </div>
</section>
