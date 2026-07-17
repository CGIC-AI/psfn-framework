import {
  SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS,
  SETTINGS_GARDEN_SECTION_FIELDS,
} from '../../../../src/shared/contracts/settings-garden-contract.js';
import type { SettingsSimpleSectionId } from '$lib/components/settings/navigation';

export interface SettingsAdvancedSection {
  id: string;
  title: string;
  keys: string[];
}

export const MODEL_OWNED_FIELDS = new Set<string>(SETTINGS_GARDEN_SECTION_FIELDS.models);

// The generic "All Fields" editor renders only advanced-surface fields per
// section. Custom-surface fields (model catalog, capability tier, scheduler
// slots) keep their dedicated editors and are intentionally excluded here so
// admins never see a generic input that the runtime write path would reject.
export const SETTINGS_ADVANCED_SECTIONS: SettingsAdvancedSection[] = [
  {
    id: 'budget', title: 'Context Budget',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.budget,
  },
  {
    id: 'memory', title: 'Memory & Extraction',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.memory,
  },
  {
    id: 'sessions', title: 'Sessions & Compaction',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.sessions,
  },
  {
    id: 'extraction-tuning', title: 'Memory Extraction Tuning',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS['extraction-tuning'],
  },
  {
    id: 'profile', title: 'Profile Synthesis',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.profile,
  },
  {
    id: 'analysis-workbench', title: 'Analysis Workbench',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS['analysis-workbench'],
  },
  {
    id: 'compositional', title: 'Compositional Cognition',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.compositional,
  },
  {
    id: 'trust', title: 'Trust & Capabilities',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.trust,
  },
  {
    id: 'llm', title: 'LLM Retries & Behavior',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.llm,
  },
  {
    id: 'import', title: 'Import Processing',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.import,
  },
  {
    id: 'fetch', title: 'Web Fetch Policy',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.fetch,
  },
  {
    id: 'voice', title: 'Voice & Speech',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.voice,
  },
  {
    id: 'obsidian', title: 'External Obsidian',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.obsidian,
  },
  {
    id: 'channels', title: 'Channels',
    keys: SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.channels,
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
// unified "Save Settings" action (which also commits the advanced canonical
// fields and the provider registry). Raw owner-file editors carry their own
// scoped save controls on the Raw JSON tab.
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
