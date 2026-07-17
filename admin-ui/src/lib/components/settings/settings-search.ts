import {
  SETTINGS_SIMPLE_SECTIONS,
  type SettingsSimpleSectionId,
} from './navigation';
import {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
  type GardenSettingsSectionId,
} from '../../settings-garden-contract';

// ── Section resolution ──
// Field metadata is keyed by the Garden field-exposure section ids
// (see settings-garden-contract). Those map onto the single Settings-page
// navigation scheme (SETTINGS_SIMPLE_SECTIONS) that owns the anchors and tabs.
//
// IMPORTANT: this map is the *curated* home of a Garden section, but a curated
// panel renders only a hand-picked subset of the fields the contract assigns to
// that section. The rest live exclusively in the generic "All Fields (Advanced)"
// editor. Search must therefore route PER FIELD (see resolveSettingsFieldRoute),
// not per section — routing every field to its section's curated home makes the
// caption lie about where the field actually is (the field is often absent).
// `compositional` has no curated panel at all; its fields live in the advanced
// editor.
export const GARDEN_SECTION_TO_SIMPLE_SECTION: Record<
  GardenSettingsSectionId,
  SettingsSimpleSectionId
> = {
  models: 'models',
  budget: 'memory-budget',
  memory: 'memory-extraction',
  sessions: 'memory-sessions',
  compositional: 'advanced-fields',
  'extraction-tuning': 'memory-tuning',
  profile: 'memory-profile',
  'analysis-workbench': 'tools-analysis-workbench',
  trust: 'advanced-trust',
  llm: 'runtime-llm',
  import: 'runtime-import',
  fetch: 'runtime-fetch',
  voice: 'integrations-voice',
  obsidian: 'integrations-obsidian',
  channels: 'channels',
};

// openSections key that expands the collapsible panel for a simple section.
// Sections rendered as always-open cards (e.g. models, memory-budget) and the
// composite "All Fields" / owner-file views have no single collapse key and are
// intentionally omitted — jumping to them scrolls without an expand step.
export const SETTINGS_SECTION_COLLAPSE_KEY: Partial<
  Record<SettingsSimpleSectionId, string>
> = {
  'memory-tuning': 'extraction-tuning',
  'memory-profile': 'profile',
  'tools-analysis-workbench': 'analysis-workbench',
  'runtime-llm': 'llm',
  'runtime-import': 'import',
  'runtime-fetch': 'fetch',
  'integrations-voice': 'voice',
  'integrations-obsidian': 'obsidian',
  channels: 'channels',
  'advanced-trust': 'trust',
  'advanced-secrets': 'secrets',
  'advanced-backup': 'backup',
};

// ── Curated-rendered field allowlist ──
// The set of contract field keys that a curated panel actually renders as an
// editable input. Curated panels expose only a subset of each Garden section's
// fields; everything else is reachable solely through the "All Fields (Advanced)"
// editor (or, for a few custom-surface fields, a delegated page / nowhere on the
// Settings page). This allowlist is the single source of truth for whether a
// field's search result may jump to a curated section.
//
// It is keyed off the real bindings in the five curated panels under
// admin-ui/src/routes/settings/ (SettingsMemoryPanels, SettingsRuntimePanels,
// SettingsIntegrationsPanels, SettingsTrustBackupPanels, SettingsDelegatedPanels)
// — each entry has a `bind:value`/`bind:checked`/`value=…+onchange` control whose
// adjacent SettingFieldLabel names the contract key. The drift test verifies this
// set against the panel files by grepping, so a stale entry fails closed.
export const CURATED_RENDERED_FIELD_KEYS: ReadonlySet<string> = new Set<string>([
  // SettingsMemoryPanels.svelte
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'extractionThresholdPct',
  'extractionInterval',
  'compactionEmotionalSalienceThresholdPct',
  'compactionThresholdPct',
  'backgroundMaintenanceIntervalMs',
  'sessionRestartBehavior',
  'memoryExtractionMinImportance',
  'memoryExtractionMinConfidence',
  'memoryExtractionMinNovelty',
  'memoryExtractionMaxWrites',
  'memoryExtractionTelemetryEnabled',
  'memoryRetrievalTelemetryEnabled',
  'profileSynthesisEnabled',
  'profileSynthesisRefreshIntervalMs',
  'profileSynthesisCooldownMs',
  'profileSynthesisMinWrites',
  'profileSynthesisMinImportance',
  'profileSynthesisMinConfidence',
  'profileSynthesisMinNovelty',
  'profileSynthesisSourceMemoryLimit',
  'profileSynthesisMinSourceMemories',
  'analysisWorkbenchMaxTokens',
  'analysisWorkbenchMaxWallTimeMs',
  'analysisWorkbenchMaxSubQueries',
  // SettingsRuntimePanels.svelte
  'retryMaxAttempts',
  'retryBaseDelayMs',
  'importProcessingRouteMode',
  'importProcessingStrictPolicy',
  'openRouterProviderOrder',
  'importProcessingLocalEndpointUrl',
  'importProcessingLocalModel',
  'webFetchAllowInternalNetwork',
  'webFetchAllowHttp',
  'webFetchDomainAllowlist',
  'webFetchTlsCaCertPaths',
  // SettingsIntegrationsPanels.svelte
  'ttsProvider',
  'sttProvider',
  'voiceId',
  'deepgramModel',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'obsidianVaultName',
  'obsidianCliPath',
  'obsidianAutoPublish',
  'obsidianTimeoutMs',
  'discordTriggerWords',
  'discordTriggerReactions',
  'discordTriggerListenWindowMs',
  'telegramEnabled',
  'telegramAuthorizedUsers',
  // SettingsTrustBackupPanels.svelte
  'capabilityTier',
  'customTokens',
]);

// Caption text for fields that live only in the generic advanced editor. Matches
// the "All Fields" tab naming; "(Advanced)" flags that it is the raw editor.
export const ADVANCED_FIELDS_SECTION_TITLE = 'All Fields (Advanced)';

export interface SettingsSearchSectionEntry {
  kind: 'section';
  sectionId: SettingsSimpleSectionId;
  title: string;
  description: string;
}

export interface SettingsSearchFieldEntry {
  kind: 'field';
  fieldKey: string;
  fieldLabel: string;
  // Simple section (and its anchor/tab) that the field jumps to.
  sectionId: SettingsSimpleSectionId;
  // Human-readable title of that section, shown as match context.
  sectionTitle: string;
  // For fields routed to the "All Fields (Advanced)" editor: the Garden section
  // group whose collapsible the jump should expand so the field is visible.
  advancedGroupId?: GardenSettingsSectionId;
}

// Per-field jump resolution. A field is reachable in exactly one of three ways:
//  - 'curated': a curated panel renders it → jump to that panel's simple section.
//  - 'advanced': surface 'advanced' but not curated-rendered → the "All Fields
//    (Advanced)" editor renders every advanced-surface field, so jump there and
//    expand the owning Garden section group.
//  - 'excluded': surface 'custom' and rendered nowhere on the Settings page
//    (model catalog is on the Models page; the episodicProcessing* slots on the
//    Scheduler editor) → produce no search entry rather than misroute the jump.
export type SettingsFieldRoute =
  | { kind: 'curated'; sectionId: SettingsSimpleSectionId; sectionTitle: string }
  | {
      kind: 'advanced';
      sectionId: 'advanced-fields';
      sectionTitle: string;
      advancedGroupId: GardenSettingsSectionId;
    }
  | { kind: 'excluded'; home: string };

function customFieldHome(
  exposure: (typeof SETTINGS_GARDEN_FIELD_EXPOSURE)[keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE],
): string {
  const editorId = 'editorId' in exposure ? exposure.editorId : undefined;
  if (editorId === 'models') return 'Models page';
  if (editorId === 'scheduler') return 'Scheduler editor';
  return 'a dedicated editor';
}

export function resolveSettingsFieldRoute(
  fieldKey: string,
  exposure: (typeof SETTINGS_GARDEN_FIELD_EXPOSURE)[keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE],
): SettingsFieldRoute {
  if (CURATED_RENDERED_FIELD_KEYS.has(fieldKey)) {
    const sectionId = GARDEN_SECTION_TO_SIMPLE_SECTION[exposure.sectionId];
    return {
      kind: 'curated',
      sectionId,
      sectionTitle: SIMPLE_SECTION_TITLE_BY_ID[sectionId],
    };
  }
  if (exposure.surface === 'advanced') {
    return {
      kind: 'advanced',
      sectionId: 'advanced-fields',
      sectionTitle: ADVANCED_FIELDS_SECTION_TITLE,
      advancedGroupId: exposure.sectionId,
    };
  }
  // Custom-surface field with no on-page editor: never jump somewhere it isn't.
  return { kind: 'excluded', home: customFieldHome(exposure) };
}

export type SettingsSearchEntry =
  | SettingsSearchSectionEntry
  | SettingsSearchFieldEntry;

export type SettingsSearchResult = SettingsSearchEntry & { score: number };

/**
 * Turn a camelCase / snake_case setting key into a spaced, title-cased label.
 * Mirrors the humanizer used by the settings editors so field search matches
 * the labels admins actually see.
 */
export function humanizeSettingFieldKey(key: string): string {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase())
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const SIMPLE_SECTION_TITLE_BY_ID = Object.fromEntries(
  SETTINGS_SIMPLE_SECTIONS.map((section) => [section.id, section.title]),
) as Record<SettingsSimpleSectionId, string>;

/**
 * Build the flat, memo-friendly search index: one entry per navigable section
 * plus one per Garden-exposed field. Pure — derived only from static metadata.
 */
export function buildSettingsSearchEntries(): SettingsSearchEntry[] {
  const sectionEntries: SettingsSearchEntry[] = SETTINGS_SIMPLE_SECTIONS.map(
    (section) => ({
      kind: 'section',
      sectionId: section.id,
      title: section.title,
      description: section.description,
    }),
  );

  const fieldEntries: SettingsSearchEntry[] = [];
  for (const [fieldKey, exposure] of Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)) {
    const route = resolveSettingsFieldRoute(fieldKey, exposure);
    // Custom-surface fields with no on-page editor are omitted rather than
    // pointed at a section that does not contain them.
    if (route.kind === 'excluded') continue;
    fieldEntries.push({
      kind: 'field',
      fieldKey,
      fieldLabel: humanizeSettingFieldKey(fieldKey),
      sectionId: route.sectionId,
      sectionTitle: route.sectionTitle,
      ...(route.kind === 'advanced'
        ? { advancedGroupId: route.advancedGroupId }
        : {}),
    });
  }

  return [...sectionEntries, ...fieldEntries];
}

/** Stable, DOM-safe identity for a result (option id, list key). */
export function settingsSearchResultKey(entry: SettingsSearchEntry): string {
  return entry.kind === 'section'
    ? `section:${entry.sectionId}`
    : `field:${entry.fieldKey}`;
}

// Default index, computed once from static metadata.
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] =
  buildSettingsSearchEntries();

interface Haystack {
  text: string;
  weight: number;
}

function entryHaystacks(entry: SettingsSearchEntry): Haystack[] {
  if (entry.kind === 'section') {
    return [
      { text: entry.title, weight: 3 },
      { text: entry.sectionId, weight: 2 },
      { text: entry.description, weight: 1 },
    ];
  }
  return [
    { text: entry.fieldLabel, weight: 3 },
    { text: entry.fieldKey, weight: 3 },
    { text: entry.sectionTitle, weight: 1 },
  ];
}

// Match strength of a single term against a single text, before weighting.
function termMatchScore(term: string, text: string): number {
  const haystack = text.toLowerCase();
  if (!haystack) return 0;
  if (haystack === term) return 4;
  if (haystack.startsWith(term)) return 3;
  // Word-boundary hit (start of any whitespace/punctuation-delimited word).
  if (new RegExp(`\\b${escapeRegExp(term)}`).test(haystack)) return 2;
  if (haystack.includes(term)) return 1;
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function primaryLabel(entry: SettingsSearchEntry): string {
  return entry.kind === 'section' ? entry.title : entry.fieldLabel;
}

/**
 * Filter and rank the search index for a query. Every whitespace-delimited term
 * must match somewhere in the entry (AND semantics); the score sums each term's
 * best weighted hit. Returns [] for an empty query. Pure and deterministic.
 */
export function filterSettingsSearchEntries(
  rawQuery: string,
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_ENTRIES,
  limit = 24,
): SettingsSearchResult[] {
  const query = rawQuery.toLowerCase().trim();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SettingsSearchResult[] = [];
  for (const entry of entries) {
    const haystacks = entryHaystacks(entry);
    let total = 0;
    let matchedEveryTerm = true;
    for (const term of terms) {
      let best = 0;
      for (const haystack of haystacks) {
        const score = termMatchScore(term, haystack.text) * haystack.weight;
        if (score > best) best = score;
      }
      if (best === 0) {
        matchedEveryTerm = false;
        break;
      }
      total += best;
    }
    if (matchedEveryTerm && total > 0) {
      results.push({ ...entry, score: total });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Sections before fields on ties, then alphabetical for stable ordering.
    if (a.kind !== b.kind) return a.kind === 'section' ? -1 : 1;
    return primaryLabel(a).localeCompare(primaryLabel(b));
  });

  return results.slice(0, limit);
}
