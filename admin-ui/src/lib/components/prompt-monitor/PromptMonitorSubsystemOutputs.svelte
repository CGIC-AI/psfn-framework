<script lang="ts">
  import type {
    AdminPromptLoomConcernOutputData,
    AdminPromptLoomContactOutputData,
    AdminPromptLoomSubsystemOutputEntry,
    AdminPromptLoomSubsystemOutputsData,
  } from '$lib/types';

  interface Props {
    outputs: AdminPromptLoomSubsystemOutputsData;
  }

  let { outputs }: Props = $props();

  function statusLabel(status: AdminPromptLoomSubsystemOutputEntry<unknown>['status']): string {
    if (status === 'not_resolved') return 'awaiting backend';
    return status;
  }

  function outputTone(status: AdminPromptLoomSubsystemOutputEntry<unknown>['status']): string {
    if (status === 'resolved') return 'bg-moss-50 text-moss-700';
    if (status === 'missing') return 'bg-wilt-50 text-wilt-600';
    return 'bg-bark-100 text-shadow-600';
  }

  function concernMeta(concern: AdminPromptLoomConcernOutputData): string {
    return [concern.status, concern.priority, concern.source, concern.sensitivity].join(' · ');
  }

  function contactMeta(contact: AdminPromptLoomContactOutputData): string {
    return [contact.relationshipType, contact.trustLevel].join(' · ');
  }
</script>

<section class="rounded-xl border border-bark-200 bg-bark-50 p-4" aria-labelledby="subsystem-outputs-title">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 id="subsystem-outputs-title" class="font-medium text-shadow-900">Subsystem Outputs</h3>
    <p class="text-xs text-shadow-600">Resolved from TurnRecord refs at read time</p>
  </div>

  <dl class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
    <div>
      <dt class="font-medium uppercase tracking-wide text-shadow-600">Context manifest</dt>
      <dd class="mt-0.5 break-all font-mono text-shadow-800">{outputs.contextManifestRef ?? 'not recorded'}</dd>
    </div>
    <div>
      <dt class="font-medium uppercase tracking-wide text-shadow-600">Internal state</dt>
      <dd class="mt-0.5 break-all font-mono text-shadow-800">{outputs.internalStateSnapshotRef ?? 'not recorded'}</dd>
    </div>
  </dl>

  <div class="mt-4 grid gap-4 xl:grid-cols-3">
    <div>
      <h4 class="text-sm font-medium text-shadow-900">Memory writes</h4>
      {#if outputs.memoryWrites.length === 0}
        <p class="mt-2 text-sm text-shadow-600">No memory writes referenced.</p>
      {:else}
        <div class="mt-2 space-y-2">
          {#each outputs.memoryWrites as entry, index (`${entry.ref}:${index}`)}
            <article class="rounded-lg border border-bark-200 bg-bark-50 p-3">
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 break-all font-mono text-xs text-shadow-700">{entry.ref}</p>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs {outputTone(entry.status)}">
                  {statusLabel(entry.status)}
                </span>
              </div>
              {#if entry.value}
                <p class="mt-2 text-xs text-shadow-600">{entry.value.type} · {entry.value.sensitivity}</p>
                <p class="mt-1 whitespace-pre-wrap text-sm text-shadow-800">{entry.value.text}</p>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>

    <div>
      <h4 class="text-sm font-medium text-shadow-900">Concern deltas</h4>
      {#if outputs.concernDeltas.length === 0}
        <p class="mt-2 text-sm text-shadow-600">No concern deltas referenced.</p>
      {:else}
        <div class="mt-2 space-y-2">
          {#each outputs.concernDeltas as entry, index (`${entry.ref}:${index}`)}
            <article class="rounded-lg border border-bark-200 bg-bark-50 p-3">
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 break-all font-mono text-xs text-shadow-700">{entry.ref}</p>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs {outputTone(entry.status)}">
                  {statusLabel(entry.status)}
                </span>
              </div>
              {#if entry.value}
                <p class="mt-2 text-xs text-shadow-600">{concernMeta(entry.value)}</p>
                <p class="mt-1 whitespace-pre-wrap text-sm text-shadow-800">{entry.value.text}</p>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>

    <div>
      <h4 class="text-sm font-medium text-shadow-900">Contact deltas</h4>
      {#if outputs.contactDeltas.length === 0}
        <p class="mt-2 text-sm text-shadow-600">No contact deltas referenced.</p>
      {:else}
        <div class="mt-2 space-y-2">
          {#each outputs.contactDeltas as entry, index (`${entry.ref}:${index}`)}
            <article class="rounded-lg border border-bark-200 bg-bark-50 p-3">
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 break-all font-mono text-xs text-shadow-700">{entry.ref}</p>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs {outputTone(entry.status)}">
                  {statusLabel(entry.status)}
                </span>
              </div>
              {#if entry.value}
                <p class="mt-2 text-sm font-medium text-shadow-900">{entry.value.displayName}</p>
                <p class="mt-0.5 text-xs text-shadow-600">{contactMeta(entry.value)}</p>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</section>
