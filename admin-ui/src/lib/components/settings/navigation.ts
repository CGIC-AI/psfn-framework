export const SETTINGS_SIMPLE_SECTIONS = [
  {
    id: 'models',
    title: 'Model Registry and Purpose Routing',
    description: 'Purpose-tagged primary/fallback models, rosters, and context windows',
  },
  {
    id: 'providers',
    title: 'Provider Registry and Backend Wiring',
    description: 'Canonical provider ids, backend base URLs, and API key env wiring',
  },
  {
    id: 'channels',
    title: 'Channels',
    description: 'Discord and Telegram behavior',
  },
  {
    id: 'memory-budget',
    title: 'Context Budget',
    description: 'Token allocation across memory and session history',
  },
  {
    id: 'memory-extraction',
    title: 'Memory & Extraction',
    description: 'Extraction thresholds and cadence controls',
  },
  {
    id: 'memory-sessions',
    title: 'Sessions & Compaction',
    description: 'Restart behavior and maintenance cadence',
  },
  {
    id: 'memory-tuning',
    title: 'Memory Extraction Tuning',
    description: 'Importance, confidence, and novelty gates',
  },
  {
    id: 'memory-profile',
    title: 'Profile Synthesis',
    description: 'Profile refresh and source-memory policy',
  },
  {
    id: 'tools-analysis-workbench',
    title: 'Analysis Workbench (RLM Sandbox)',
    description: 'Sandbox limits for large-context analysis',
  },
  {
    id: 'prompting',
    title: 'Prompt Stack and Authoring',
    description: 'Prompt layers and authoring workspace',
  },
  {
    id: 'runtime-llm',
    title: 'LLM Retries & Behavior',
    description: 'Retries and request pacing',
  },
  {
    id: 'runtime-import',
    title: 'Import Processing',
    description: 'Import flow route and strict policy',
  },
  {
    id: 'runtime-fetch',
    title: 'Web Fetch Policy',
    description: 'Network and TLS constraints',
  },
  {
    id: 'integrations-voice',
    title: 'Voice & TTS',
    description: 'TTS and STT provider wiring',
  },
  {
    id: 'integrations-obsidian',
    title: 'External Obsidian Bridge',
    description: 'External vault bridge and import source',
  },
  {
    id: 'advanced-trust',
    title: 'Trust & Capabilities',
    description: 'Autonomy tier and capability tokens',
  },
  {
    id: 'advanced-fleet-auth',
    title: 'Cluster Authentication',
    description: 'Read-only effective and canonical owner state',
    groupId: 'trust',
  },
  {
    id: 'advanced-backup',
    title: 'Backups',
    description: 'Backup schedule, rotation, and mirror settings',
  },
  {
    id: 'advanced-fields',
    title: 'All Canonical Fields',
    description: 'Full settings contract fields with owner-source context',
  },
  {
    id: 'advanced-secrets',
    title: 'Secrets (Read-Only)',
    description: 'Read-only runtime environment values',
  },
  {
    id: 'owner-files',
    title: 'Raw Owner-File Editors',
    description: 'Raw JSON editors for canonical config owner files',
  },
] as const;

export type SettingsSimpleSection = (typeof SETTINGS_SIMPLE_SECTIONS)[number];
export type SettingsSimpleSectionId = SettingsSimpleSection['id'];

const SIMPLE_SECTION_IDS = new Set<string>(
  SETTINGS_SIMPLE_SECTIONS.map((section) => section.id),
);

const SECTION_ANCHOR_PREFIX = 'settings-';

export function isSettingsSimpleSectionId(value: string): value is SettingsSimpleSectionId {
  return SIMPLE_SECTION_IDS.has(value);
}

export function settingsSimpleSectionAnchorId(sectionId: SettingsSimpleSectionId): string {
  return `${SECTION_ANCHOR_PREFIX}${sectionId}`;
}

export function settingsSimpleSectionHref(sectionId: SettingsSimpleSectionId): string {
  return `#${settingsSimpleSectionAnchorId(sectionId)}`;
}

export function parseSettingsSimpleSectionHash(hash: string): SettingsSimpleSectionId | null {
  const normalized = hash.trim().replace(/^#/, '');
  if (!normalized.startsWith(SECTION_ANCHOR_PREFIX)) {
    return null;
  }
  const sectionId = normalized.slice(SECTION_ANCHOR_PREFIX.length);
  return isSettingsSimpleSectionId(sectionId) ? sectionId : null;
}
