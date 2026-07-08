export const SETTINGS_IA_GROUPS = [
  { id: 'models', label: 'Models' },
  { id: 'providers', label: 'Providers' },
  { id: 'prompting', label: 'Prompting' },
  { id: 'memory', label: 'Memory' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'tools', label: 'Tools' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'channels', label: 'Channels' },
  { id: 'trust', label: 'Trust' },
  { id: 'backups', label: 'Backups' },
  { id: 'owner-files', label: 'Owner Files' },
] as const;

export const SETTINGS_SIMPLE_SECTIONS = [
  {
    id: 'models',
    title: 'Model Registry',
    description: 'Provider and purpose routing',
    groupId: 'models',
  },
  {
    id: 'providers',
    title: 'Provider Registry',
    description: 'Backend endpoints and API key env wiring',
    groupId: 'providers',
  },
  {
    id: 'channels',
    title: 'Channel Bridges',
    description: 'Discord and Telegram behavior',
    groupId: 'channels',
  },
  {
    id: 'memory-budget',
    title: 'Context Budget',
    description: 'Token allocation across memory and session history',
    groupId: 'memory',
  },
  {
    id: 'memory-extraction',
    title: 'Memory & Extraction',
    description: 'Extraction thresholds and cadence controls',
    groupId: 'memory',
  },
  {
    id: 'memory-sessions',
    title: 'Sessions & Compaction',
    description: 'Restart behavior and maintenance cadence',
    groupId: 'sessions',
  },
  {
    id: 'memory-tuning',
    title: 'Extraction Tuning',
    description: 'Importance, confidence, and novelty gates',
    groupId: 'memory',
  },
  {
    id: 'memory-profile',
    title: 'Profile Synthesis',
    description: 'Profile refresh and source-memory policy',
    groupId: 'memory',
  },
  {
    id: 'tools-analysis-workbench',
    title: 'Analysis Workbench',
    description: 'Sandbox limits for large-context analysis',
    groupId: 'tools',
  },
  {
    id: 'prompting',
    title: 'Prompt Stack',
    description: 'Prompt layers and authoring workspace',
    groupId: 'prompting',
  },
  {
    id: 'runtime-llm',
    title: 'LLM Runtime Policy',
    description: 'Retries and request pacing',
    groupId: 'runtime',
  },
  {
    id: 'runtime-import',
    title: 'Import Routing',
    description: 'Import flow route and strict policy',
    groupId: 'runtime',
  },
  {
    id: 'runtime-fetch',
    title: 'Web Fetch Policy',
    description: 'Network and TLS constraints',
    groupId: 'runtime',
  },
  {
    id: 'integrations-voice',
    title: 'Voice Pipeline',
    description: 'TTS and STT provider wiring',
    groupId: 'integrations',
  },
  {
    id: 'integrations-obsidian',
    title: 'External Obsidian',
    description: 'Legacy vault bridge and import source',
    groupId: 'integrations',
  },
  {
    id: 'advanced-trust',
    title: 'Trust & Capabilities',
    description: 'Autonomy tier and capability tokens',
    groupId: 'trust',
  },
  {
    id: 'advanced-backup',
    title: 'Backups',
    description: 'Backup schedule, rotation, and mirror settings',
    groupId: 'backups',
  },
  {
    id: 'advanced-fields',
    title: 'All Canonical Fields',
    description: 'Full settings contract fields with owner-source context',
    groupId: 'runtime',
  },
  {
    id: 'advanced-secrets',
    title: 'Secrets Snapshot',
    description: 'Read-only runtime environment values',
    groupId: 'trust',
  },
  {
    id: 'owner-files',
    title: 'Owner-File Editors',
    description: 'Raw JSON editors for canonical config owner files',
    groupId: 'owner-files',
  },
] as const;

export type SettingsIaGroupId = (typeof SETTINGS_IA_GROUPS)[number]['id'];
export type SettingsSimpleSection = (typeof SETTINGS_SIMPLE_SECTIONS)[number];
export type SettingsSimpleSectionId = SettingsSimpleSection['id'];

export interface SettingsSimpleSectionGroup {
  id: SettingsIaGroupId;
  label: (typeof SETTINGS_IA_GROUPS)[number]['label'];
  sections: SettingsSimpleSection[];
}

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

export function buildSettingsSimpleSectionGroups(options: {
  includeSections?: ReadonlySet<SettingsSimpleSectionId>;
} = {}): SettingsSimpleSectionGroup[] {
  const { includeSections } = options;
  const include = (sectionId: SettingsSimpleSectionId): boolean => (
    !includeSections || includeSections.has(sectionId)
  );

  return SETTINGS_IA_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      sections: SETTINGS_SIMPLE_SECTIONS.filter(
        (section) => section.groupId === group.id && include(section.id),
      ),
    }))
    .filter((group) => group.sections.length > 0);
}

export function resolveActiveSettingsSimpleSection(
  orderedSectionIds: readonly SettingsSimpleSectionId[],
  topBySectionId: Partial<Record<SettingsSimpleSectionId, number>>,
  thresholdPx = 160,
): SettingsSimpleSectionId | null {
  let fallback: SettingsSimpleSectionId | null = null;
  let active: SettingsSimpleSectionId | null = null;

  for (const sectionId of orderedSectionIds) {
    const sectionTop = topBySectionId[sectionId];
    if (typeof sectionTop !== 'number' || Number.isNaN(sectionTop)) {
      continue;
    }
    if (!fallback) {
      fallback = sectionId;
    }
    if (sectionTop <= thresholdPx) {
      active = sectionId;
    }
  }

  return active ?? fallback;
}
