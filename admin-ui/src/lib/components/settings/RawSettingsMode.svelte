<script lang="ts">
  import type { GardenSettingsRawEditorKey } from '$lib/settings-garden-contract';

  export interface RawSettingsEditorView {
    key: Exclude<GardenSettingsRawEditorKey, 'settings' | 'models'>;
    ownerFile: string;
    loadError?: string;
  }

  type RawSettingsEditorKey = RawSettingsEditorView['key'];

  interface RawSaveStatus {
    ok: boolean;
    msg: string;
  }

  let {
    settingsJson,
    rawEditors,
    rawSaveStatus,
    saving,
    retryingRawEditorKey,
    validationErrorsByField,
    setSettingsJson,
    getRawJson,
    setRawJson,
    saveRawSettings,
    saveRawConfig,
    retryRawConfig,
  } = $props<{
    settingsJson: string;
    rawEditors: RawSettingsEditorView[];
    rawSaveStatus: Record<string, RawSaveStatus>;
    saving: boolean;
    retryingRawEditorKey: RawSettingsEditorKey | null;
    validationErrorsByField: Record<string, string[]>;
    setSettingsJson: (value: string) => void;
    getRawJson: (key: string) => string;
    setRawJson: (key: string, value: string) => void;
    saveRawSettings: () => void | Promise<void>;
    saveRawConfig: (key: string, label: string) => void | Promise<void>;
    retryRawConfig: (key: RawSettingsEditorKey) => void | Promise<void>;
  }>();

  function validationErrorEntries(): Array<[string, string[]]> {
    return Object.entries(validationErrorsByField);
  }
</script>

<div class="space-y-4">
  <div class="card-garden overflow-hidden">
    <div class="flex items-center justify-between px-5 py-3 border-b border-bark-300">
      <h3 class="text-sm font-serif font-semibold text-shadow-800">settings.json (full runtime object)</h3>
      <div class="flex items-center gap-3">
        {#if rawSaveStatus['settings']}
          <span class="text-sm font-medium {rawSaveStatus['settings'].ok ? 'text-moss-600' : 'text-wilt-600'}">
            {rawSaveStatus['settings'].msg}
          </span>
        {/if}
        <button
          onclick={saveRawSettings}
          disabled={saving}
          class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
    <textarea
      value={settingsJson}
      oninput={(event) => setSettingsJson((event.target as HTMLTextAreaElement).value)}
      rows="18"
      class="w-full font-mono text-sm text-shadow-800 bg-bark-50 p-4
             focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset
             resize-y border-0"
      spellcheck="false"
    ></textarea>
    {#if Object.keys(validationErrorsByField).length > 0}
      <div class="px-5 pb-4 border-t border-bark-300 space-y-1">
        {#each validationErrorEntries() as [field, messages]}
          {#each messages as message}
            <p class="text-sm text-wilt-600">
              <span class="font-mono">{field}</span>: {message}
            </p>
          {/each}
        {/each}
      </div>
    {/if}
  </div>

  {#each rawEditors as editor}
    {@const status = rawSaveStatus[editor.key]}
    {@const ownerFile = editor.ownerFile}
    {@const loadError = editor.loadError}
    {@const loadErrorId = `raw-editor-${editor.key}-load-error`}
    <div class="card-garden overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3 border-b border-bark-300">
        <h3 class="text-sm font-serif font-semibold text-shadow-800">{ownerFile}</h3>
        <div class="flex items-center gap-3">
          {#if status}
            <span class="text-sm font-medium {status.ok ? 'text-moss-600' : 'text-wilt-600'}">
              {status.msg}
            </span>
          {/if}
          {#if loadError}
            <button
              onclick={() => retryRawConfig(editor.key)}
              disabled={saving || retryingRawEditorKey === editor.key}
              class="px-3 py-1.5 rounded-lg border border-wilt-300 bg-wilt-50 text-wilt-700 text-sm font-medium
                     hover:bg-wilt-100 disabled:opacity-50 transition-colors"
            >
              {retryingRawEditorKey === editor.key ? 'Retrying...' : 'Retry load'}
            </button>
          {/if}
          <button
            onclick={() => saveRawConfig(editor.key, ownerFile)}
            disabled={saving || Boolean(loadError)}
            class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                   hover:bg-gold-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      {#if loadError}
        <div id={loadErrorId} role="alert" class="border-b border-wilt-300 bg-wilt-50/70 px-5 py-3">
          <p class="text-sm font-medium text-wilt-700">{loadError}</p>
        </div>
      {/if}
      <textarea
        value={getRawJson(editor.key)}
        oninput={(event) => setRawJson(editor.key, (event.target as HTMLTextAreaElement).value)}
        disabled={Boolean(loadError)}
        aria-describedby={loadError ? loadErrorId : undefined}
        rows="14"
        class="w-full font-mono text-sm text-shadow-800 bg-bark-50 p-4
               focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset
               resize-y border-0 disabled:cursor-not-allowed disabled:opacity-60"
        spellcheck="false"
      ></textarea>
    </div>
  {/each}
</div>
