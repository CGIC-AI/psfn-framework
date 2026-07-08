<script lang="ts">
  import type { DiffPreviewResponse } from '$lib/api/endpoints/identity';
  import type { AdminIdentityData, CharacterCardV2 } from '$lib/types';

  type CardDiffField = {
    field: string;
    label: string;
    current: string;
    target: string;
    changed: boolean;
  };

  interface Props {
    data: AdminIdentityData;
    showVersionHistory: boolean;
    rollbackMessage: string;
    diffVersion: number | null;
    diffLoading: boolean;
    diffData: DiffPreviewResponse | null;
    rollingBack: number | null;
    onToggleVersionHistory: () => void;
    handleShowDiff: (version: number) => void | Promise<void>;
    openRollbackConfirmation: (version: number) => void;
    buildCardDiff: (current: CharacterCardV2, target: CharacterCardV2) => CardDiffField[];
  }

  let {
    data,
    showVersionHistory,
    rollbackMessage,
    diffVersion,
    diffLoading,
    diffData,
    rollingBack,
    onToggleVersionHistory,
    handleShowDiff,
    openRollbackConfirmation,
    buildCardDiff,
  }: Props = $props();
</script>

<!-- Version History -->
{#if data.history && data.history.length > 0}
  <div class="card-garden overflow-hidden">
    <button
      class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
      onclick={onToggleVersionHistory}
    >
      <div>
        <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Version History</h3>
        <p class="text-sm text-shadow-600 mt-0.5">
          Current: <span class="font-medium text-shadow-800">v{data.version ?? 1}</span>
          <span class="mx-1 text-shadow-500">|</span>
          {data.history.length} version{data.history.length === 1 ? '' : 's'} recorded
        </p>
      </div>
      <svg class="w-4 h-4 text-shadow-600 transition-transform {showVersionHistory ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    {#if showVersionHistory}
    <div class="border-t border-bark-300">
    {#if rollbackMessage}
      <div class="mx-5 mt-3 mb-3 px-3 py-2 rounded-lg bg-moss-50 text-sm text-moss-600 border border-moss-200">{rollbackMessage}</div>
    {/if}

    <!-- Version history table -->
    <div class="px-5 pb-5 pt-3">
      <div class="overflow-x-auto border border-bark-300 rounded-lg">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-bark-100 border-b border-bark-300">
              <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Version</th>
              <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Changed By</th>
              <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Timestamp</th>
              <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Previous Checksum</th>
              <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each [...data.history].reverse().slice(0, 20) as entry (entry.version)}
              {@const isCurrent = entry.version === (data.version ?? 1) - 1}
              <tr class="border-b border-bark-200 hover:bg-bark-50 transition-colors {isCurrent ? 'bg-gold-50' : ''}">
                <td class="px-3 py-2 font-mono text-shadow-800 font-medium">
                  v{entry.version} &rarr; v{entry.version + 1}
                </td>
                <td class="px-3 py-2 text-shadow-700">{entry.updatedBy ?? entry.changedBy ?? 'unknown'}</td>
                <td class="px-3 py-2 text-shadow-700">{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown'}</td>
                <td class="px-3 py-2">
                  <code class="font-mono text-shadow-600 text-sm">{(entry.previousChecksum ?? entry.checksum ?? 'n/a').slice(0, 12)}</code>
                </td>
                <td class="px-3 py-2">
                  <div class="flex gap-1.5">
                    <button
                      onclick={() => handleShowDiff(entry.version)}
                      class="px-2.5 py-1 text-sm font-medium rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 hover:border-gold-300 transition-colors"
                    >
                      {diffVersion === entry.version ? 'Hide' : 'Diff'}
                    </button>
                    <button
                      onclick={() => openRollbackConfirmation(entry.version)}
                      disabled={rollingBack === entry.version}
                      class="px-2.5 py-1 text-sm font-medium rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors disabled:opacity-50"
                    >
                      {rollingBack === entry.version ? '...' : 'Restore'}
                    </button>
                  </div>
                </td>
              </tr>

              <!-- Inline diff panel -->
              {#if diffVersion === entry.version}
                <tr>
                  <td colspan="5" class="p-0">
                    <div class="p-4 border-t border-bark-200 bg-bark-50">
                      {#if diffLoading}
                        <div class="animate-pulse space-y-2">
                          <div class="h-4 bg-bark-200 rounded w-1/3"></div>
                          <div class="h-4 bg-bark-200 rounded w-2/3"></div>
                        </div>
                      {:else if diffData && diffData.ok}
                        {@const allFields = buildCardDiff(diffData.current, diffData.target)}
                        <p class="text-sm text-shadow-700 mb-3">
                          Comparing <span class="font-medium text-shadow-900">current (v{data.version})</span>
                          with <span class="font-medium text-shadow-900">v{entry.version}</span>
                          {#if allFields.every(f => !f.changed)}
                            <span class="text-shadow-600 ml-1">(no differences)</span>
                          {/if}
                        </p>

                        <!-- Side-by-side diff table for ALL fields -->
                        <div class="overflow-x-auto border border-bark-300 rounded-lg">
                          <table class="w-full text-sm">
                            <thead>
                              <tr class="bg-bark-100 border-b border-bark-300">
                                <th class="text-left px-3 py-2 text-shadow-700 font-medium w-36">Field</th>
                                <th class="text-left px-3 py-2 text-shadow-700 font-medium">Current</th>
                                <th class="text-left px-3 py-2 text-shadow-700 font-medium">v{entry.version}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each allFields as fd}
                                <tr class="border-b border-bark-200 {fd.changed ? '' : ''}">
                                  <td class="px-3 py-2 font-medium text-shadow-800 align-top">{fd.label}</td>
                                  <td
                                    class="px-3 py-2 align-top font-mono text-sm whitespace-pre-wrap max-w-xs overflow-hidden"
                                    style={fd.changed ? 'background-color: #FFF9E6; border-left: 3px solid #E8C766;' : ''}
                                  >
                                    <div class="max-h-32 overflow-y-auto text-shadow-800">{fd.current || '(empty)'}</div>
                                  </td>
                                  <td
                                    class="px-3 py-2 align-top font-mono text-sm whitespace-pre-wrap max-w-xs overflow-hidden"
                                    style={fd.changed ? 'background-color: #FFF9E6; border-left: 3px solid #E8C766;' : ''}
                                  >
                                    <div class="max-h-32 overflow-y-auto text-shadow-800">{fd.target || '(empty)'}</div>
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <p class="text-sm text-shadow-600">Unable to load diff for this version.</p>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
    </div>
    {/if}
  </div>
{/if}
