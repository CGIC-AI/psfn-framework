import { SETTINGS_GARDEN_SECTION_FIELDS } from '$lib/settings-garden-contract';
import type { SettingsSimpleSectionId } from '$lib/components/settings/navigation';

export interface SettingsAdvancedSection {
  id: string;
  title: string;
  icon: string;
  keys: string[];
}

export const MODEL_OWNED_FIELDS = new Set<string>(SETTINGS_GARDEN_SECTION_FIELDS.models);

export const SETTINGS_ADVANCED_SECTIONS: SettingsAdvancedSection[] = [
  {
    id: 'budget', title: 'Context Budget', icon: 'B',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.budget,
  },
  {
    id: 'memory', title: 'Memory & Extraction', icon: 'E',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.memory,
  },
  {
    id: 'sessions', title: 'Sessions & Compaction', icon: 'S',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.sessions,
  },
  {
    id: 'extraction-tuning', title: 'Memory Extraction Tuning', icon: 'X',
    keys: SETTINGS_GARDEN_SECTION_FIELDS['extraction-tuning'],
  },
  {
    id: 'profile', title: 'Profile Synthesis', icon: 'P',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.profile,
  },
  {
    id: 'analysis-workbench', title: 'Analysis Workbench', icon: 'R',
    keys: SETTINGS_GARDEN_SECTION_FIELDS['analysis-workbench'],
  },
  {
    id: 'compositional', title: 'Compositional Cognition', icon: 'K',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.compositional,
  },
  {
    id: 'trust', title: 'Trust & Capabilities', icon: 'T',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.trust,
  },
  {
    id: 'llm', title: 'LLM Retries & Behavior', icon: 'L',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.llm,
  },
  {
    id: 'import', title: 'Import Processing', icon: 'I',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.import,
  },
  {
    id: 'fetch', title: 'Web Fetch Policy', icon: 'W',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.fetch,
  },
  {
    id: 'voice', title: 'Voice & Speech', icon: 'V',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.voice,
  },
  {
    id: 'obsidian', title: 'External Obsidian', icon: 'O',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.obsidian,
  },
  {
    id: 'channels', title: 'Channels', icon: 'C',
    keys: SETTINGS_GARDEN_SECTION_FIELDS.channels,
  },
];

// ── Tab definitions ──
// Single navigation scheme for the Settings page: every simple section lives in
// exactly one tab. Section anchors (settingsSimpleSectionAnchorId) stay stable,
// so #settings-<section> deep links resolve to the owning tab.
export const SETTINGS_TAB_DEFINITIONS = [
  {
    id: 'providers',
    label: 'Models & Providers',
    sections: ['models', 'prompting', 'providers'],
  },
  {
    id: 'memory',
    label: 'Memory',
    sections: [
      'memory-budget',
      'memory-extraction',
      'memory-sessions',
      'memory-tuning',
      'memory-profile',
      'tools-analysis-workbench',
    ],
  },
  {
    id: 'runtime',
    label: 'Runtime',
    sections: ['runtime-llm', 'runtime-import', 'runtime-fetch'],
  },
  {
    id: 'integrations',
    label: 'Channels & Voice',
    sections: ['integrations-voice', 'integrations-obsidian', 'channels'],
  },
  {
    id: 'trust',
    label: 'Trust & Backup',
    sections: ['advanced-trust', 'advanced-secrets', 'advanced-backup'],
  },
  {
    id: 'advanced',
    label: 'All Fields',
    sections: ['advanced-fields'],
  },
  {
    id: 'raw',
    label: 'Raw JSON',
    sections: ['owner-files'],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  sections: readonly SettingsSimpleSectionId[];
}[];

export type SettingsTabDefinition = (typeof SETTINGS_TAB_DEFINITIONS)[number];
export type SettingsTabId = SettingsTabDefinition['id'];

// Tabs whose content is edited through the curated form and saved with the
// shared "Save Curated Settings" action. Advanced fields and raw owner-file
// editors carry their own save controls.
export const CURATED_SETTINGS_TAB_IDS: readonly SettingsTabId[] = [
  'providers',
  'memory',
  'runtime',
  'integrations',
  'trust',
];

const TAB_IDS = new Set<string>(SETTINGS_TAB_DEFINITIONS.map((tab) => tab.id));

export function isSettingsTabId(value: string): value is SettingsTabId {
  return TAB_IDS.has(value);
}

export function settingsTabForSection(sectionId: SettingsSimpleSectionId): SettingsTabId {
  for (const tab of SETTINGS_TAB_DEFINITIONS) {
    if ((tab.sections as readonly SettingsSimpleSectionId[]).includes(sectionId)) {
      return tab.id;
    }
  }
  // Every SettingsSimpleSectionId is assigned above; fail closed to the first tab.
  return SETTINGS_TAB_DEFINITIONS[0].id;
}
