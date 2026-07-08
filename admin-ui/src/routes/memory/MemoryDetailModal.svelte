<script lang="ts">
  import type {
    AdminMemoryContactSummary,
    AdminMemoryDetailData,
    AdminMemoryLink,
    AdminUiPurrMemory,
  } from '$lib/types';

  type TimestampLike = number | string | null | undefined;

  type ScopeLike = {
    kind: string;
    id: string;
    label?: string;
  };

  interface Props {
    detailModalData: AdminMemoryDetailData | null;
    detailModalLoading: boolean;
    detailModalError: string;
    detailMemoryId: string;
    contactsById: Record<string, AdminMemoryContactSummary>;
    linksById: Record<string, AdminMemoryLink[]>;
    linkTargetById: Record<string, string>;
    linkTypeById: Record<string, string>;
    loadingLinksFor: string | null;
    memoryLinkTypes: string[];
    scopeEditorRefLabel: string;
    scopeEditorTags: string;
    scopeMutating: boolean;
    supersedeConfirmId: string | null;
    revealingId: string | null;
    typeBadgeStyle: (type: string) => string;
    sensitivityBadgeStyle: (sensitivity: string) => string;
    isDurableMemoryView: (memory: AdminUiPurrMemory) => boolean;
    isPreferenceMemoryView: (memory: AdminUiPurrMemory) => boolean;
    memText: (memory: AdminUiPurrMemory) => string;
    memCreated: (memory: AdminUiPurrMemory) => TimestampLike;
    memUpdated: (memory: AdminUiPurrMemory) => TimestampLike;
    memEmotion: (memory: AdminUiPurrMemory) => number;
    memSuperseded: (memory: AdminUiPurrMemory) => TimestampLike;
    memTags: (memory: AdminUiPurrMemory) => string;
    formatDate: (timestamp: TimestampLike) => string;
    saliencePercent: (value: number | undefined) => string;
    scopeKindLabel: (kind: string) => string;
    scopeLabel: (scope: ScopeLike) => string;
    onClose: () => void;
    onReveal: (id: string) => void | Promise<void>;
    onScopeRepair: (id: string) => void | Promise<void>;
    onScopeSave: (id: string) => void | Promise<void>;
    onSupersede: (id: string) => void | Promise<void>;
    onSupersedeConfirmChange: (id: string | null) => void;
    onLinkTargetChange: (id: string, value: string) => void;
    onLinkTypeChange: (id: string, value: string) => void;
    onLinkMemory: (id: string) => void | Promise<void>;
    onUnlinkMemory: (memoryId: string, id1: string, id2: string) => void | Promise<void>;
    onScopeEditorRefLabelChange: (value: string) => void;
    onScopeEditorTagsChange: (value: string) => void;
  }

  let {
    detailModalData,
    detailModalLoading,
    detailModalError,
    detailMemoryId,
    contactsById,
    linksById,
    linkTargetById,
    linkTypeById,
    loadingLinksFor,
    memoryLinkTypes,
    scopeEditorRefLabel,
    scopeEditorTags,
    scopeMutating,
    supersedeConfirmId,
    revealingId,
    typeBadgeStyle,
    sensitivityBadgeStyle,
    isDurableMemoryView,
    isPreferenceMemoryView,
    memText,
    memCreated,
    memUpdated,
    memEmotion,
    memSuperseded,
    memTags,
    formatDate,
    saliencePercent,
    scopeKindLabel,
    scopeLabel,
    onClose,
    onReveal,
    onScopeRepair,
    onScopeSave,
    onSupersede,
    onSupersedeConfirmChange,
    onLinkTargetChange,
    onLinkTypeChange,
    onLinkMemory,
    onUnlinkMemory,
    onScopeEditorRefLabelChange,
    onScopeEditorTagsChange,
  }: Props = $props();
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(event) => {
    if (event.currentTarget === event.target) {
      onClose();
    }
  }}
>
  <div
    class="card-garden w-full max-w-4xl max-h-[90vh] overflow-y-auto p-5 space-y-4"
    role="dialog"
    aria-modal="true"
    aria-label="Memory detail"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="font-serif text-xl text-shadow-900 font-semibold">Memory Detail</h2>
        {#if detailModalData}
          <p class="text-shadow-600 text-xs mt-1">
            ID: <code class="text-shadow-800 bg-bark-200 px-1 rounded">{detailModalData.memory.id}</code>
          </p>
        {/if}
      </div>
      <button
        onclick={onClose}
        class="px-3 py-1 rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 transition-colors text-sm"
      >
        Close
      </button>
    </div>

    {#if detailModalLoading}
      <div class="space-y-2">
        <div class="h-4 bg-bark-200 rounded w-1/3 animate-pulse"></div>
        <div class="h-3 bg-bark-200 rounded w-full animate-pulse"></div>
        <div class="h-3 bg-bark-200 rounded w-5/6 animate-pulse"></div>
      </div>
    {:else if detailModalError}
      <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3">
        <p class="text-sm text-wilt-600">{detailModalError}</p>
      </div>
    {:else if detailModalData}
      <div class="space-y-4 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={typeBadgeStyle(detailModalData.memory.type ?? 'unknown')}>
            {detailModalData.memory.type ?? 'unknown'}
          </span>
          {#if detailModalData.memory.sensitivity}
            <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={sensitivityBadgeStyle(detailModalData.memory.sensitivity)}>
              {detailModalData.memory.sensitivity}
            </span>
          {/if}
          {#if isDurableMemoryView(detailModalData.memory)}
            <span class="px-2 py-0.5 text-sm rounded border bg-moss-50 text-moss-700 border-moss-200">
              durable
            </span>
          {/if}
          {#if isPreferenceMemoryView(detailModalData.memory)}
            <span class="px-2 py-0.5 text-sm rounded border bg-gold-50 text-gold-800 border-gold-200">
              preference
            </span>
          {/if}
          {#if detailModalData.linkedContact}
            <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-800 border-bark-300">
              {detailModalData.linkedContact.displayName}
            </span>
          {:else if detailModalData.memory.contactId && contactsById[detailModalData.memory.contactId]}
            <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-800 border-bark-300">
              {contactsById[detailModalData.memory.contactId].displayName}
            </span>
          {/if}
        </div>

        {#if detailModalData.memory.bodyRedacted}
          <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3 space-y-2">
            <p class="text-sm font-medium text-wilt-700">
              Body redacted ({detailModalData.memory.bodyRedaction?.sensitivity ?? detailModalData.memory.sensitivity}
              {detailModalData.memory.bodyRedaction ? ` -- ${detailModalData.memory.bodyRedaction.originalLength} chars hidden` : ''})
            </p>
            <p class="text-sm text-wilt-700">
              {detailModalData.memory.bodyRedaction?.revealHint ?? 'Reveal this memory or elevate memory body access to view (both are audit-logged).'}
            </p>
            <button
              onclick={() => { void onReveal(detailMemoryId); }}
              disabled={revealingId === detailModalData.memory.id}
              class="px-3 py-1.5 rounded-lg border border-wilt-300 text-wilt-700 text-sm font-medium
                     hover:bg-wilt-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {revealingId === detailModalData.memory.id ? 'Revealing...' : 'Reveal body (audited)'}
            </button>
          </div>
        {:else}
          <p class="text-shadow-800 leading-relaxed">{memText(detailModalData.memory)}</p>
        {/if}

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-shadow-700">
          <span>Extracted: <span class="text-shadow-800">{formatDate(memCreated(detailModalData.memory))}</span></span>
          <span>Last Accessed: <span class="text-shadow-800">{formatDate(memUpdated(detailModalData.memory))}</span></span>
          <span>Importance: <span class="text-shadow-800">{((detailModalData.memory.importance ?? 0) * 100).toFixed(0)}%</span></span>
          <span>Salience: <span class="text-shadow-800">{saliencePercent(detailModalData.memory.salience)}%</span></span>
          {#if detailModalData.memory.confidence !== undefined}
            <span>Confidence: <span class="text-shadow-800">{((detailModalData.memory.confidence ?? 0) * 100).toFixed(0)}%</span></span>
          {/if}
          <span>Emotional Valence: <span class="text-shadow-800">{(memEmotion(detailModalData.memory) * 100).toFixed(0)}%</span></span>
          {#if memSuperseded(detailModalData.memory)}
            <span>Superseded: <span class="text-shadow-800">{formatDate(memSuperseded(detailModalData.memory))}</span></span>
          {/if}
          {#if detailModalData.memory.accessCount !== undefined}
            <span>Access Count: <span class="text-shadow-800">{detailModalData.memory.accessCount}</span></span>
          {/if}
          {#if detailModalData.memory.retentionClass}
            <span>Retention: <span class="text-shadow-800">{detailModalData.memory.retentionClass}</span></span>
          {/if}
          {#if detailModalData.memory.sourceRef}
            <span class="sm:col-span-2">Source: <code class="text-shadow-800 bg-bark-200 px-1 rounded text-sm break-all">{detailModalData.memory.sourceRef}</code></span>
          {/if}
          {#if memTags(detailModalData.memory)}
            <span class="sm:col-span-2">Tags: <span class="text-shadow-800">{memTags(detailModalData.memory)}</span></span>
          {/if}
          {#if Object.keys(detailModalData.memory.consentFlags ?? {}).length > 0}
            <span class="sm:col-span-2">
              Consent flags:
              <code class="text-shadow-800 bg-bark-200 px-1 rounded text-sm break-all">
                {JSON.stringify(detailModalData.memory.consentFlags)}
              </code>
            </span>
          {/if}
        </div>

        <div class="rounded-xl border border-bark-200 bg-bark-50 p-4 space-y-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="font-medium text-shadow-900">Managed Scope Attachment</p>
              <p class="mt-1 text-xs text-shadow-600">
                Project and north-star scope refs and tags persisted on this memory.
              </p>
            </div>
            {#if detailModalData.scopeRepair?.needsRepair}
              <button
                onclick={() => { void onScopeRepair(detailMemoryId); }}
                disabled={scopeMutating}
                class="px-3 py-1.5 rounded-lg border border-gold-500 text-gold-800 text-sm font-medium hover:bg-gold-50 disabled:opacity-50"
              >
                Repair Tags
              </button>
            {/if}
          </div>

          {#if detailModalData.scopeAssignments.length === 0}
            <p class="text-sm text-shadow-600">No managed project or north-star scope is attached.</p>
          {:else}
            <div class="space-y-3">
              {#each detailModalData.scopeAssignments as assignment}
                <div class="rounded-lg border border-bark-200 bg-white/70 p-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">
                      {scopeKindLabel(assignment.kind)}
                    </span>
                    <span class="text-sm font-medium text-shadow-900">{scopeLabel(assignment)}</span>
                    <code class="text-xs text-shadow-700">{assignment.canonicalTag}</code>
                  </div>
                  <div class="mt-2 space-y-1">
                    {#each assignment.evidence as evidence}
                      <div class="rounded border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-700">
                        <span class="font-medium text-shadow-900">{evidence.type}:</span>
                        <code class="ml-1">{evidence.value}</code>
                        <span class="ml-1">{evidence.detail}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          {#if detailModalData.memory.scopeRef}
            <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
              <input
                type="text"
                value={scopeEditorRefLabel}
                oninput={(event) => onScopeEditorRefLabelChange((event.currentTarget as HTMLInputElement).value)}
                placeholder="Scope label"
                class="px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm"
              />
              <input
                type="text"
                value={scopeEditorTags}
                oninput={(event) => onScopeEditorTagsChange((event.currentTarget as HTMLInputElement).value)}
                placeholder="Comma-separated scope tags"
                class="px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm"
              />
              <button
                onclick={() => { void onScopeSave(detailMemoryId); }}
                disabled={scopeMutating}
                class="px-3 py-2 rounded-lg bg-moss-500 text-white text-sm font-medium hover:bg-moss-600 disabled:opacity-50"
              >
                Save Scope
              </button>
            </div>
          {/if}

          {#if detailModalData.scopeRepair}
            <div class="text-xs text-shadow-600 space-y-1">
              {#if detailModalData.scopeRepair.suggestedScopeRef}
                <p>
                  Suggested scopeRef:
                  <code>{detailModalData.scopeRepair.suggestedScopeRef.kind}:{detailModalData.scopeRepair.suggestedScopeRef.id}</code>
                </p>
              {/if}
              <p>
                Suggested tags:
                <code>{detailModalData.scopeRepair.suggestedScopeTags.join(', ') || 'none'}</code>
              </p>
              {#each detailModalData.scopeRepair.notes as note}
                <p>{note}</p>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Supersede button (not "Delete" - backend calls supersedeMemory) -->
        <div class="flex justify-end pt-2 border-t border-bark-200">
          {#if supersedeConfirmId === detailModalData.memory.id}
            <div class="flex flex-wrap items-center justify-end gap-2">
              <span class="text-shadow-700">
                Supersede this memory? It will be marked as replaced.
              </span>
              <button
                onclick={() => { void onSupersede(detailMemoryId); }}
                class="px-3 py-1 rounded bg-wilt-400 text-white hover:bg-wilt-600 transition-colors text-sm font-medium"
              >
                Yes, Supersede
              </button>
              <button
                onclick={() => onSupersedeConfirmChange(null)}
                class="px-3 py-1 rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 transition-colors text-sm"
              >
                Cancel
              </button>
            </div>
          {:else}
            <button
              onclick={() => onSupersedeConfirmChange(detailMemoryId)}
              class="px-3 py-1 rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors text-sm font-medium"
              title="Mark this memory as superseded (replaced). The original is preserved but hidden from active retrieval."
            >
              Supersede
            </button>
          {/if}
        </div>

        <!-- Memory links -->
        <div class="pt-2 border-t border-bark-200 space-y-2">
          <p class="text-shadow-700 font-medium text-sm">Memory Links</p>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              placeholder="Target memory ID"
              value={linkTargetById[detailModalData.memory.id] ?? ''}
              oninput={(event) => onLinkTargetChange(detailMemoryId, (event.currentTarget as HTMLInputElement).value)}
              class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
            />
            <select
              value={linkTypeById[detailModalData.memory.id] ?? 'related'}
              onchange={(event) => onLinkTypeChange(detailMemoryId, (event.currentTarget as HTMLSelectElement).value)}
              class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
            >
              {#each memoryLinkTypes as linkType}
                <option value={linkType}>{linkType}</option>
              {/each}
            </select>
            <button
              onclick={() => { void onLinkMemory(detailMemoryId); }}
              class="px-3 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 transition-colors"
            >
              Link
            </button>
          </div>

          {#if loadingLinksFor === detailModalData.memory.id}
            <p class="text-shadow-600 text-sm">Loading links...</p>
          {:else if (linksById[detailModalData.memory.id] ?? []).length === 0}
            <p class="text-shadow-600 text-sm">No links for this memory.</p>
          {:else}
            <div class="space-y-1">
              {#each linksById[detailModalData.memory.id] ?? [] as link}
                <div class="flex items-center justify-between rounded border border-bark-200 bg-bark-50 px-2 py-1 text-sm">
                  <span class="text-shadow-800">
                    <code>{link.id1}</code> <span class="mx-1">↔</span> <code>{link.id2}</code> ({link.linkType})
                  </span>
                  <button
                    onclick={() => { void onUnlinkMemory(detailMemoryId, link.id1, link.id2); }}
                    class="text-wilt-600 hover:text-wilt-700 font-medium"
                  >
                    Unlink
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
