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
// Every field-owning Garden section resolves to the simple section that hosts
// it so field matches reuse jumpToSection with no parallel navigation scheme.
// `compositional` has no dedicated curated section; its fields live in the
// generic "All Fields" editor, so it resolves there.
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

  const fieldEntries: SettingsSearchEntry[] = Object.entries(
    SETTINGS_GARDEN_FIELD_EXPOSURE,
  ).map(([fieldKey, exposure]) => {
    const sectionId = GARDEN_SECTION_TO_SIMPLE_SECTION[exposure.sectionId];
    return {
      kind: 'field',
      fieldKey,
      fieldLabel: humanizeSettingFieldKey(fieldKey),
      sectionId,
      sectionTitle: SIMPLE_SECTION_TITLE_BY_ID[sectionId],
    };
  });

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
