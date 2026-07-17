<script lang="ts">
  import { base } from '$app/paths';
  import { setContext } from 'svelte';
  import SettingAuthorityHint from '$lib/components/settings/SettingAuthorityHint.svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import SettingsCollapsibleSection from '$lib/components/settings/SettingsCollapsibleSection.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import type { SettingAuthorityInfo } from '$lib/settings/authority';
  import {
    SETTINGS_FIELD_ERRORS_CONTEXT,
    fmtMs,
    fmtTokens,
    formatSettingOptionLabel,
    settingControlId,
    settingLabelId,
    type SettingsFieldErrorsAccessor,
  } from './settings-page-helpers';

  let {
    openSections,
    sessionRestartBehaviorOptions,
    inputClass,
    labelClass,
    sliderClass,
    compactInputClass,
    toggleClass,
    getSource,
    getSettingAuthority,
    fieldErrors,
    toggleSection,
    sessionRestartBehavior = $bindable<'reuse_latest_session' | 'new_session'>('reuse_latest_session'),
    sessionHistoryBudgetPct = $bindable(6),
    memoryRetrievalBudgetPct = $bindable(2),
    extractionThresholdPct = $bindable(30),
    compactionThresholdPct = $bindable(70),
    extractionInterval = $bindable(5),
    compactionEmotionalSalienceThresholdPct = $bindable(75),
    backgroundMaintenanceIntervalMs = $bindable(3600000),
    memoryExtractionMinImportance = $bindable(0.3),
    memoryExtractionMinConfidence = $bindable(0.4),
    memoryExtractionMinNovelty = $bindable(0.1),
    memoryExtractionMaxWrites = $bindable(20),
    memoryExtractionTelemetryEnabled = $bindable(true),
    memoryRetrievalTelemetryEnabled = $bindable(true),
    profileSynthesisEnabled = $bindable(true),
    profileSynthesisRefreshIntervalMs = $bindable(3600000),
    profileSynthesisCooldownMs = $bindable(300000),
    profileSynthesisMinWrites = $bindable(1),
    profileSynthesisMinImportance = $bindable(0.65),
    profileSynthesisMinConfidence = $bindable(0.7),
    profileSynthesisMinNovelty = $bindable(0.12),
    profileSynthesisSourceMemoryLimit = $bindable(16),
    profileSynthesisMinSourceMemories = $bindable(2),
    analysisWorkbenchMaxTokens = $bindable(76000),
    analysisWorkbenchMaxWallTimeMs = $bindable(300000),
    analysisWorkbenchMaxSubQueries = $bindable(12),
  } = $props<{
    openSections: Set<string>;
    sessionRestartBehaviorOptions: string[];
    inputClass: string;
    labelClass: string;
    sliderClass: string;
    compactInputClass: string;
    toggleClass: string;
    getSource: (key: string) => string;
    getSettingAuthority: (key: string) => SettingAuthorityInfo;
    fieldErrors: SettingsFieldErrorsAccessor;
    toggleSection: (id: string) => void;
    sessionRestartBehavior: 'reuse_latest_session' | 'new_session';
    sessionHistoryBudgetPct: number;
    memoryRetrievalBudgetPct: number;
    extractionThresholdPct: number;
    compactionThresholdPct: number;
    extractionInterval: number;
    compactionEmotionalSalienceThresholdPct: number;
    backgroundMaintenanceIntervalMs: number;
    memoryExtractionMinImportance: number;
    memoryExtractionMinConfidence: number;
    memoryExtractionMinNovelty: number;
    memoryExtractionMaxWrites: number;
    memoryExtractionTelemetryEnabled: boolean;
    memoryRetrievalTelemetryEnabled: boolean;
    profileSynthesisEnabled: boolean;
    profileSynthesisRefreshIntervalMs: number;
    profileSynthesisCooldownMs: number;
    profileSynthesisMinWrites: number;
    profileSynthesisMinImportance: number;
    profileSynthesisMinConfidence: number;
    profileSynthesisMinNovelty: number;
    profileSynthesisSourceMemoryLimit: number;
    profileSynthesisMinSourceMemories: number;
    analysisWorkbenchMaxTokens: number;
    analysisWorkbenchMaxWallTimeMs: number;
    analysisWorkbenchMaxSubQueries: number;
  }>();

  // Publish the validation-error accessor to descendant SettingFieldLabels so
  // curated controls render their field's errors inline (ybm3).
  setContext<SettingsFieldErrorsAccessor>(SETTINGS_FIELD_ERRORS_CONTEXT, (key) => fieldErrors(key));
</script>

<section
  id={settingsSimpleSectionAnchorId('memory-budget')}
  class="space-y-5"
  data-settings-section="memory-budget"
>
  <div class="card-garden p-6 space-y-6">
    <h2 class="text-sm font-serif font-semibold text-shadow-800">Context Budget</h2>
    <hr class="divider-filigree" />
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel
          label="Session History Budget %"
          keys="sessionHistoryBudgetPct"
          source={getSource('sessionHistoryBudgetPct')}
          labelId={settingLabelId('sessionHistoryBudgetPct')}
          class={labelClass}
        />
        <div class="flex items-center gap-3">
          <input id={settingControlId('sessionHistoryBudgetPct', 'range')} aria-labelledby={settingLabelId('sessionHistoryBudgetPct')} type="range" min="1" max="80" step="1" bind:value={sessionHistoryBudgetPct} class={sliderClass} />
          <input id={settingControlId('sessionHistoryBudgetPct', 'number')} aria-labelledby={settingLabelId('sessionHistoryBudgetPct')} type="number" min="1" max="80" bind:value={sessionHistoryBudgetPct} class={compactInputClass} />
        </div>
        <p class="text-sm text-shadow-500 mt-1">% of context window for session history (default: 6%). Runtime keeps whole messages within this token budget.</p>
      </div>
      <div>
        <SettingFieldLabel
          label="Memory Retrieval Budget %"
          keys="memoryRetrievalBudgetPct"
          source={getSource('memoryRetrievalBudgetPct')}
          labelId={settingLabelId('memoryRetrievalBudgetPct')}
          class={labelClass}
        />
        <div class="flex items-center gap-3">
          <input id={settingControlId('memoryRetrievalBudgetPct', 'range')} aria-labelledby={settingLabelId('memoryRetrievalBudgetPct')} type="range" min="1" max="50" step="1" bind:value={memoryRetrievalBudgetPct} class={sliderClass} />
          <input id={settingControlId('memoryRetrievalBudgetPct', 'number')} aria-labelledby={settingLabelId('memoryRetrievalBudgetPct')} type="number" min="1" max="50" bind:value={memoryRetrievalBudgetPct} class={compactInputClass} />
        </div>
        <p class="text-sm text-shadow-500 mt-1">% of context window for memory retrieval (default: 2%). Runtime keeps whole memories within this token budget.</p>
      </div>
    </div>
    <div class="rounded-xl border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-700">
      The context window allocation preview lives on the Dashboard.
      <a href={`${base}/`} class="ml-1 font-medium text-gold-700 hover:text-gold-800">Open Dashboard</a>
    </div>
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('memory-extraction')}
  data-settings-section="memory-extraction"
>
  <div class="card-garden p-6 space-y-6">
    <h2 class="text-sm font-serif font-semibold text-shadow-800">Memory & Extraction</h2>
    <hr class="divider-filigree" />
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel
          label="Extraction Threshold %"
          keys="extractionThresholdPct"
          source={getSource('extractionThresholdPct')}
          labelId={settingLabelId('extractionThresholdPct')}
          class={labelClass}
        />
        <div class="flex items-center gap-3">
          <input id={settingControlId('extractionThresholdPct', 'range')} aria-labelledby={settingLabelId('extractionThresholdPct')} type="range" min="10" max="80" step="1" bind:value={extractionThresholdPct} class={sliderClass} />
          <input id={settingControlId('extractionThresholdPct', 'number')} aria-labelledby={settingLabelId('extractionThresholdPct')} type="number" min="10" max="80" bind:value={extractionThresholdPct} class={compactInputClass} />
        </div>
        <p class="text-sm text-shadow-500 mt-1">Triggers extraction when session exceeds this % of context</p>
      </div>
      <div>
        <SettingFieldLabel label="Extraction Interval (messages)" keys="extractionInterval" forId={settingControlId('extractionInterval')} class={labelClass} />
        <input id={settingControlId('extractionInterval')} type="number" min="1" max="50" bind:value={extractionInterval} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Run extraction every N messages (1-50)</p>
      </div>
      <div>
        <SettingFieldLabel
          label="Emotional Salience Threshold %"
          keys="compactionEmotionalSalienceThresholdPct"
          labelId={settingLabelId('compactionEmotionalSalienceThresholdPct')}
          class={labelClass}
        />
        <div class="flex items-center gap-3">
          <input id={settingControlId('compactionEmotionalSalienceThresholdPct', 'range')} aria-labelledby={settingLabelId('compactionEmotionalSalienceThresholdPct')} type="range" min="0" max="100" step="1" bind:value={compactionEmotionalSalienceThresholdPct} class={sliderClass} />
          <input id={settingControlId('compactionEmotionalSalienceThresholdPct', 'number')} aria-labelledby={settingLabelId('compactionEmotionalSalienceThresholdPct')} type="number" min="0" max="100" bind:value={compactionEmotionalSalienceThresholdPct} class={compactInputClass} />
        </div>
        <p class="text-sm text-shadow-500 mt-1">Preserve messages above this emotional salience during compaction (0-100)</p>
      </div>
    </div>
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('memory-sessions')}
  data-settings-section="memory-sessions"
>
  <div class="card-garden p-6 space-y-6">
    <h2 class="text-sm font-serif font-semibold text-shadow-800">Sessions & Compaction</h2>
    <hr class="divider-filigree" />
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel
          label="Compaction Threshold %"
          keys="compactionThresholdPct"
          source={getSource('compactionThresholdPct')}
          labelId={settingLabelId('compactionThresholdPct')}
          class={labelClass}
        />
        <div class="flex items-center gap-3">
          <input id={settingControlId('compactionThresholdPct', 'range')} aria-labelledby={settingLabelId('compactionThresholdPct')} type="range" min="30" max="90" step="1" bind:value={compactionThresholdPct} class={sliderClass} />
          <input id={settingControlId('compactionThresholdPct', 'number')} aria-labelledby={settingLabelId('compactionThresholdPct')} type="number" min="30" max="90" bind:value={compactionThresholdPct} class={compactInputClass} />
        </div>
        <p class="text-sm text-shadow-500 mt-1">Auto-compacts oldest 50% when context exceeds this %</p>
      </div>
      <div>
        <SettingFieldLabel
          label="Bundled Background Maintenance Interval (ms)"
          keys="backgroundMaintenanceIntervalMs"
          source={getSource('backgroundMaintenanceIntervalMs')}
          forId={settingControlId('backgroundMaintenanceIntervalMs')}
          class={labelClass}
        />
        <input id={settingControlId('backgroundMaintenanceIntervalMs')} type="number" min="10000" step="1000" bind:value={backgroundMaintenanceIntervalMs} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">One shared hourly tick for salience decay, ambient presence, concern grooming, social-graph proposals, sleeptime eligibility, contact trust drift, drift velocity, and second-arrow checks. The Scheduler page lists the exact operations wired in this runtime.</p>
        <SettingAuthorityHint info={getSettingAuthority('backgroundMaintenanceIntervalMs')} />
      </div>
      <div>
        <SettingFieldLabel
          label="Restart Behavior"
          keys="sessionRestartBehavior"
          source={getSource('sessionRestartBehavior')}
          forId={settingControlId('sessionRestartBehavior')}
          class={labelClass}
        />
        <select id={settingControlId('sessionRestartBehavior')} bind:value={sessionRestartBehavior} class={inputClass}>
          {#each sessionRestartBehaviorOptions as option}
            <option value={option}>{formatSettingOptionLabel('sessionRestartBehavior', option)}</option>
          {/each}
        </select>
        <p class="text-sm text-shadow-500 mt-1">Choose whether startup resumes the latest session or seeds a fresh one.</p>
      </div>
    </div>
    <div class="rounded-xl border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-700">
      Heartbeat schedules, one-shot timers, and maintenance queue state are delegated to Scheduler.
      <a href={`${base}/scheduler`} class="ml-1 font-medium text-gold-700 hover:text-gold-800">Open Scheduler</a>
    </div>
  </div>
</section>

<section
  id={settingsSimpleSectionAnchorId('memory-tuning')}
  data-settings-section="memory-tuning"
>
  <SettingsCollapsibleSection
    title="Memory Extraction Tuning"
    open={openSections.has('extraction-tuning')}
    onToggle={() => toggleSection('extraction-tuning')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">Min importance: {memoryExtractionMinImportance}, Max writes: {memoryExtractionMaxWrites}</span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel label="Min Importance" keys="memoryExtractionMinImportance" forId={settingControlId('memoryExtractionMinImportance')} class={labelClass} />
        <input id={settingControlId('memoryExtractionMinImportance')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinImportance} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum importance score to write a memory (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Confidence" keys="memoryExtractionMinConfidence" forId={settingControlId('memoryExtractionMinConfidence')} class={labelClass} />
        <input id={settingControlId('memoryExtractionMinConfidence')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinConfidence} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum confidence score to write a memory (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Novelty" keys="memoryExtractionMinNovelty" forId={settingControlId('memoryExtractionMinNovelty')} class={labelClass} />
        <input id={settingControlId('memoryExtractionMinNovelty')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinNovelty} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum novelty score to write a memory (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Max Writes per Extraction" keys="memoryExtractionMaxWrites" forId={settingControlId('memoryExtractionMaxWrites')} class={labelClass} />
        <input id={settingControlId('memoryExtractionMaxWrites')} type="number" min="1" max="100" step="1" bind:value={memoryExtractionMaxWrites} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Maximum memories written per extraction cycle</p>
      </div>
      <div>
        <SettingFieldLabel label="Extraction Telemetry" keys="memoryExtractionTelemetryEnabled" labelId={settingLabelId('memoryExtractionTelemetryEnabled')} class={labelClass} />
        <label class="flex items-center gap-2 mt-2 cursor-pointer">
          <input id={settingControlId('memoryExtractionTelemetryEnabled')} aria-labelledby={settingLabelId('memoryExtractionTelemetryEnabled')} type="checkbox" bind:checked={memoryExtractionTelemetryEnabled} class={toggleClass} />
          <span class="text-sm text-shadow-700">Log extraction telemetry data</span>
        </label>
      </div>
      <div>
        <SettingFieldLabel label="Retrieval Telemetry" keys="memoryRetrievalTelemetryEnabled" labelId={settingLabelId('memoryRetrievalTelemetryEnabled')} class={labelClass} />
        <label class="flex items-center gap-2 mt-2 cursor-pointer">
          <input id={settingControlId('memoryRetrievalTelemetryEnabled')} aria-labelledby={settingLabelId('memoryRetrievalTelemetryEnabled')} type="checkbox" bind:checked={memoryRetrievalTelemetryEnabled} class={toggleClass} />
          <span class="text-sm text-shadow-700">Log retrieval telemetry data</span>
        </label>
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('memory-profile')}
  data-settings-section="memory-profile"
>
  <SettingsCollapsibleSection
    title="Profile Synthesis"
    open={openSections.has('profile')}
    onToggle={() => toggleSection('profile')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">{profileSynthesisEnabled ? 'Enabled' : 'Disabled'}</span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel label="Enabled" keys="profileSynthesisEnabled" labelId={settingLabelId('profileSynthesisEnabled')} class={labelClass} />
        <label class="flex items-center gap-2 mt-2 cursor-pointer">
          <input id={settingControlId('profileSynthesisEnabled')} aria-labelledby={settingLabelId('profileSynthesisEnabled')} type="checkbox" bind:checked={profileSynthesisEnabled} class={toggleClass} />
          <span class="text-sm text-shadow-700">Enable automatic profile synthesis</span>
        </label>
      </div>
      <div>
        <SettingFieldLabel label="Refresh Interval (ms)" keys="profileSynthesisRefreshIntervalMs" forId={settingControlId('profileSynthesisRefreshIntervalMs')} class={labelClass} />
        <input id={settingControlId('profileSynthesisRefreshIntervalMs')} type="number" min="60000" step="60000" bind:value={profileSynthesisRefreshIntervalMs} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">How often to refresh profiles ({fmtMs(profileSynthesisRefreshIntervalMs)})</p>
      </div>
      <div>
        <SettingFieldLabel label="Cooldown (ms)" keys="profileSynthesisCooldownMs" forId={settingControlId('profileSynthesisCooldownMs')} class={labelClass} />
        <input id={settingControlId('profileSynthesisCooldownMs')} type="number" min="10000" step="10000" bind:value={profileSynthesisCooldownMs} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum wait between profile updates ({fmtMs(profileSynthesisCooldownMs)})</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Writes" keys="profileSynthesisMinWrites" forId={settingControlId('profileSynthesisMinWrites')} class={labelClass} />
        <input id={settingControlId('profileSynthesisMinWrites')} type="number" min="1" max="100" step="1" bind:value={profileSynthesisMinWrites} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum memory writes before triggering synthesis</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Importance" keys="profileSynthesisMinImportance" forId={settingControlId('profileSynthesisMinImportance')} class={labelClass} />
        <input id={settingControlId('profileSynthesisMinImportance')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinImportance} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum importance for source memories (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Confidence" keys="profileSynthesisMinConfidence" forId={settingControlId('profileSynthesisMinConfidence')} class={labelClass} />
        <input id={settingControlId('profileSynthesisMinConfidence')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinConfidence} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum confidence for source memories (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Novelty" keys="profileSynthesisMinNovelty" forId={settingControlId('profileSynthesisMinNovelty')} class={labelClass} />
        <input id={settingControlId('profileSynthesisMinNovelty')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinNovelty} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum novelty for source memories (0-1)</p>
      </div>
      <div>
        <SettingFieldLabel label="Source Memory Limit" keys="profileSynthesisSourceMemoryLimit" forId={settingControlId('profileSynthesisSourceMemoryLimit')} class={labelClass} />
        <input id={settingControlId('profileSynthesisSourceMemoryLimit')} type="number" min="1" max="200" step="1" bind:value={profileSynthesisSourceMemoryLimit} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Max source memories to consider per synthesis</p>
      </div>
      <div>
        <SettingFieldLabel label="Min Source Memories" keys="profileSynthesisMinSourceMemories" forId={settingControlId('profileSynthesisMinSourceMemories')} class={labelClass} />
        <input id={settingControlId('profileSynthesisMinSourceMemories')} type="number" min="1" max="50" step="1" bind:value={profileSynthesisMinSourceMemories} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Minimum source memories required to run synthesis</p>
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('tools-analysis-workbench')}
  data-settings-section="tools-analysis-workbench"
>
  <SettingsCollapsibleSection
    title="Analysis Workbench (RLM Sandbox)"
    open={openSections.has('analysis-workbench')}
    onToggle={() => toggleSection('analysis-workbench')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">Max: {fmtTokens(analysisWorkbenchMaxTokens)} tokens, {fmtMs(analysisWorkbenchMaxWallTimeMs)}, {analysisWorkbenchMaxSubQueries} queries</span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
      <div>
        <SettingFieldLabel label="Max Tokens" keys="analysisWorkbenchMaxTokens" forId={settingControlId('analysisWorkbenchMaxTokens')} class={labelClass} />
        <input id={settingControlId('analysisWorkbenchMaxTokens')} type="number" min="1000" max="1000000" step="1000" bind:value={analysisWorkbenchMaxTokens} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Max tokens for RLM sandbox (1K-1M)</p>
      </div>
      <div>
        <SettingFieldLabel label="Max Wall Time (ms)" keys="analysisWorkbenchMaxWallTimeMs" forId={settingControlId('analysisWorkbenchMaxWallTimeMs')} class={labelClass} />
        <input id={settingControlId('analysisWorkbenchMaxWallTimeMs')} type="number" min="5000" max="600000" step="1000" bind:value={analysisWorkbenchMaxWallTimeMs} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Max wall-clock time ({fmtMs(analysisWorkbenchMaxWallTimeMs)})</p>
      </div>
      <div>
        <SettingFieldLabel label="Max Sub-Queries" keys="analysisWorkbenchMaxSubQueries" forId={settingControlId('analysisWorkbenchMaxSubQueries')} class={labelClass} />
        <input id={settingControlId('analysisWorkbenchMaxSubQueries')} type="number" min="1" max="100" step="1" bind:value={analysisWorkbenchMaxSubQueries} class={inputClass} />
        <p class="text-sm text-shadow-500 mt-1">Max LLM sub-queries per analysis workbench run (1-100)</p>
      </div>
    </div>
    <div class="mt-4 rounded-xl border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-700">
      Tool availability, health, and recent failures are delegated to Tools.
      <a href={`${base}/tools`} class="ml-1 font-medium text-gold-700 hover:text-gold-800">Open Tools</a>
    </div>
  </SettingsCollapsibleSection>
</section>
