export type CanonicalToolExposure = 'core' | 'extended';
export type RetiredToolExposure = 'hidden' | 'retired';

export type FirstPartyToolDomain =
  | 'adaptive_tooling'
  | 'analysis'
  | 'boundary'
  | 'contacts'
  | 'identity'
  | 'knowledge'
  | 'memory'
  | 'media'
  | 'notification'
  | 'orientation'
  | 'scheduler'
  | 'self_expression'
  | 'sessions'
  | 'subagents'
  | 'system'
  | 'tracked_work';

export interface ToolCapabilityMetadata {
  kind: 'static' | 'action_aware' | 'external_policy';
  source: string;
}

export interface RetiredToolCharterException {
  owner: string;
  expiresAt: string;
  reason: string;
}

export interface RetiredToolAlias {
  alias: string;
  canonicalName: string;
  exposure: RetiredToolExposure;
  replacementAction?: string;
  reason: string;
  charterException?: RetiredToolCharterException;
}

export interface CanonicalToolSurfaceEntry {
  name: string;
  domain: FirstPartyToolDomain;
  exposure: CanonicalToolExposure;
  description: string;
  actions?: readonly string[];
  capabilityMetadata: ToolCapabilityMetadata;
  retiredAliases: readonly RetiredToolAlias[];
}

const CAPABILITIES_REQUIREMENTS = 'src/system/capabilities/requirements.ts';
const TOOLSET_RUNTIME = 'src/core/agent/substrate-agent/adaptive-tools-runtime.ts';

export const MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES = [
  'session_new',
  'session_resume',
  'session_list',
  'session_search',
  'session_grep',
  'start_focus',
  'complete_focus',
  'focus_start',
  'focus_complete',
  'values_add',
  'values_update',
  'values_list',
  'create_concern',
  'list_concerns',
  'resolve_concern',
  'north_star_list',
  'north_star_create',
  'north_star_update',
  'north_star_delete',
  'north_star_reorder',
  'self_restart',
  'self_rebuild',
  'spawn_subagent',
  'image_create',
  'image_edit',
  'image_analyze',
  'scratchpad_write',
  'memory_import_batch',
  'memory_patch',
  'memory_redact',
  'memory_delete',
  'undo_memory_delete',
  'contact_note',
  'contact_set_trust',
  'contact_link_identity',
  'contact_set_channel_privacy',
] as const;

const MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIAS_SET = new Set<string>(
  MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES,
);

function retiredAlias(
  alias: string,
  canonicalName: string,
  exposure: RetiredToolExposure,
  replacementAction: string | undefined,
  reason: string,
): RetiredToolAlias {
  return {
    alias,
    canonicalName,
    exposure,
    ...(replacementAction ? { replacementAction } : {}),
    reason,
  };
}

export const CANONICAL_FIRST_PARTY_TOOL_SURFACES: readonly CanonicalToolSurfaceEntry[] = [
  {
    name: 'tool_search',
    domain: 'adaptive_tooling',
    exposure: 'core',
    description: 'Canonical discovery surface for non-default first-party tools.',
    actions: ['search'],
    capabilityMetadata: { kind: 'static', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'toolset',
    domain: 'adaptive_tooling',
    exposure: 'core',
    description: 'Canonical control surface for listing, suggesting, activating, pinning, and unpinning non-default tools.',
    actions: ['list', 'suggest', 'describe', 'activate', 'pin', 'unpin'],
    capabilityMetadata: { kind: 'action_aware', source: TOOLSET_RUNTIME },
    retiredAliases: [
      retiredAlias('load_tools', 'toolset', 'hidden', 'activate', 'Discovery-driven activation belongs on toolset.'),
      retiredAlias('promoted_tools_list', 'toolset', 'hidden', 'list', 'Promoted-tool state belongs on toolset.'),
      retiredAlias('promoted_tools_add', 'toolset', 'hidden', 'pin', 'Pinned overlay mutation belongs on toolset.'),
      retiredAlias('promoted_tools_remove', 'toolset', 'hidden', 'unpin', 'Pinned overlay mutation belongs on toolset.'),
      retiredAlias('promoted_tools_swap', 'toolset', 'hidden', undefined, 'Slot shuffling is not a model-facing semantic operation.'),
    ],
  },
  {
    name: 'response_control',
    domain: 'system',
    exposure: 'core',
    description: 'Canonical response-disposition surface for intentional no-reply decisions.',
    actions: ['no_reply'],
    capabilityMetadata: { kind: 'static', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'fs',
    domain: 'boundary',
    exposure: 'core',
    description: 'Canonical filesystem surface.',
    actions: ['read', 'list', 'search', 'write', 'edit'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('fs_read', 'fs', 'hidden', 'read', 'Filesystem reads belong on fs.'),
      retiredAlias('fs_list', 'fs', 'hidden', 'list', 'Filesystem listing belongs on fs.'),
    ],
  },
  {
    name: 'repo',
    domain: 'boundary',
    exposure: 'core',
    description: 'Canonical repository inspection and guarded mutation surface.',
    actions: ['inspect', 'patch', 'commit', 'branch', 'publish'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('repo_status', 'repo', 'hidden', 'inspect', 'Repository status belongs on repo.'),
      retiredAlias('repo_diff', 'repo', 'hidden', 'inspect', 'Repository diff belongs on repo.'),
      retiredAlias('repo_apply_patch', 'repo', 'hidden', 'patch', 'Repository patching belongs on repo.'),
      retiredAlias('repo_commit', 'repo', 'hidden', 'commit', 'Repository commits belong on repo.'),
      retiredAlias('repo_create_branch', 'repo', 'hidden', 'branch', 'Repository branch creation belongs on repo.'),
      retiredAlias('repo_open_pr', 'repo', 'hidden', 'publish', 'Repository publishing belongs on repo.'),
    ],
  },
  {
    name: 'shell',
    domain: 'boundary',
    exposure: 'core',
    description: 'Canonical shell execution surface.',
    actions: ['exec'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('shell_exec', 'shell', 'hidden', 'exec', 'Shell execution belongs on shell.'),
    ],
  },
  {
    name: 'web',
    domain: 'boundary',
    exposure: 'core',
    description: 'Canonical web retrieval and small-scope discovery surface.',
    actions: ['fetch', 'browse', 'search'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('web_fetch', 'web', 'hidden', 'fetch', 'Web fetching belongs on web.'),
      retiredAlias('crawler_fetch', 'web', 'hidden', 'browse', 'Crawler-lane browsing belongs on web.'),
      retiredAlias('web_research', 'web', 'hidden', 'search', 'Small-scope web research belongs on web.'),
    ],
  },
  {
    name: 'analysis_workbench',
    domain: 'analysis',
    exposure: 'core',
    description: 'Canonical bounded multi-stage analysis surface.',
    capabilityMetadata: { kind: 'static', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'orient',
    domain: 'orientation',
    exposure: 'core',
    description: 'Canonical active-orientation surface for persona, human, goals, values, and active concerns.',
    actions: [
      'append',
      'replace',
      'reorient',
      'values_list',
      'values_add',
      'values_update',
      'create_concern',
      'list_concerns',
      'resolve_concern',
      'transition_concern',
    ],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('core_memory_append', 'orient', 'hidden', 'append', 'Orientation append belongs on orient.'),
      retiredAlias('core_memory_replace', 'orient', 'hidden', 'replace', 'Orientation replacement belongs on orient.'),
      retiredAlias('memory_rethink', 'orient', 'hidden', 'reorient', 'Orientation refresh belongs on orient.'),
      retiredAlias('values_list', 'orient', 'hidden', 'values_list', 'Values reads belong on orient.'),
      retiredAlias('values_add', 'orient', 'retired', 'values_add', 'Values journaling belongs on orient.'),
      retiredAlias('values_update', 'orient', 'retired', 'values_update', 'Values revision belongs on orient.'),
      retiredAlias('create_concern', 'orient', 'hidden', 'create_concern', 'Active concerns belong on orient.'),
      retiredAlias('list_concerns', 'orient', 'hidden', 'list_concerns', 'Active concerns belong on orient.'),
      retiredAlias('resolve_concern', 'orient', 'hidden', 'resolve_concern', 'Active concerns belong on orient.'),
    ],
  },
  {
    name: 'identity',
    domain: 'identity',
    exposure: 'core',
    description: 'Canonical identity and prompt-layer surface.',
    actions: [
      'list_layers',
      'get_layer',
      'diff_layer',
      'history',
      'update_layer',
      'rollback_layer',
      'toggle_layer',
      'update_persona',
      'commit_stage',
      'cancel_stage',
    ],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('persona_update', 'identity', 'hidden', 'update_persona', 'Persona mutation belongs on identity.'),
      retiredAlias('character_card_update', 'identity', 'hidden', 'update_persona', 'Character-card mutation belongs on identity.'),
    ],
  },
  {
    name: 'memory',
    domain: 'memory',
    exposure: 'core',
    description: 'Canonical long-term memory surface.',
    actions: ['write', 'search', 'census', 'exists', 'timeline', 'import', 'patch', 'redact', 'delete', 'restore'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('memory_write', 'memory', 'retired', 'write', 'Memory writes belong on memory.'),
      retiredAlias('memory_import_batch', 'memory', 'retired', 'import', 'Memory imports belong on memory.'),
      retiredAlias('memory_patch', 'memory', 'retired', 'patch', 'Memory edits belong on memory.'),
      retiredAlias('memory_redact', 'memory', 'retired', 'redact', 'Memory redaction belongs on memory.'),
      retiredAlias('memory_delete', 'memory', 'retired', 'delete', 'Memory deletion belongs on memory.'),
      retiredAlias('undo_memory_delete', 'memory', 'retired', 'restore', 'Memory restoration belongs on memory.'),
    ],
  },
  {
    name: 'scratchpad',
    domain: 'memory',
    exposure: 'core',
    description: 'Canonical ephemeral working-context surface.',
    actions: ['list', 'add', 'replace', 'append', 'remove'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('scratchpad_read', 'scratchpad', 'retired', 'list', 'Scratchpad reads belong on scratchpad.'),
      retiredAlias('scratchpad_write', 'scratchpad', 'retired', 'add', 'Scratchpad writes belong on scratchpad.'),
    ],
  },
  {
    name: 'contact',
    domain: 'contacts',
    exposure: 'core',
    description: 'Canonical contact, trust, note, identity-link, and channel-privacy surface.',
    actions: ['list', 'lookup', 'note', 'set_trust', 'propose_trust', 'link_identity', 'set_channel_privacy', 'set_machine_intelligence'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('contact_list', 'contact', 'retired', 'list', 'Contact reads belong on contact.'),
      retiredAlias('contact_lookup', 'contact', 'retired', 'lookup', 'Contact lookup belongs on contact.'),
      retiredAlias('contact_note', 'contact', 'retired', 'note', 'Contact notes belong on contact.'),
      retiredAlias('contact_set_trust', 'contact', 'retired', 'set_trust', 'Trust mutation belongs on contact.'),
      retiredAlias('contact_link_identity', 'contact', 'retired', 'link_identity', 'Identity linking belongs on contact.'),
      retiredAlias('contact_set_channel_privacy', 'contact', 'retired', 'set_channel_privacy', 'Channel privacy belongs on contact.'),
    ],
  },
  {
    name: 'session',
    domain: 'sessions',
    exposure: 'core',
    description: 'Canonical session continuity, transcript search, resume, and focus surface.',
    actions: ['list', 'new', 'resume', 'search', 'grep', 'wake_return', 'start_focus', 'complete_focus'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('session_list', 'session', 'hidden', 'list', 'Session listing belongs on session.'),
      retiredAlias('session_new', 'session', 'retired', 'new', 'Session creation belongs on session.'),
      retiredAlias('session_resume', 'session', 'retired', 'resume', 'Session resume belongs on session.'),
      retiredAlias('session_search', 'session', 'hidden', 'search', 'Transcript search belongs on session.'),
      retiredAlias('session_grep', 'session', 'hidden', 'grep', 'Transcript grep belongs on session.'),
      retiredAlias('continuity_list', 'session', 'hidden', 'list_continuity', 'Continuity lookup belongs on session.'),
      retiredAlias('wake_return_summary', 'session', 'hidden', 'wake_return', 'Wake/return summarization belongs on session.'),
      retiredAlias('start_focus', 'session', 'retired', 'start_focus', 'Focus start belongs on session.'),
      retiredAlias('complete_focus', 'session', 'retired', 'complete_focus', 'Focus completion belongs on session.'),
      retiredAlias('focus_start', 'session', 'retired', 'start_focus', 'Focus start belongs on session.'),
      retiredAlias('focus_complete', 'session', 'retired', 'complete_focus', 'Focus completion belongs on session.'),
    ],
  },
  {
    name: 'self_status',
    domain: 'system',
    exposure: 'core',
    description: 'Canonical companion-facing safe runtime self-status surface.',
    actions: ['snapshot', 'diagnose', 'logs', 'conformance'],
    capabilityMetadata: { kind: 'static', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'system',
    domain: 'system',
    exposure: 'core',
    description: 'Canonical runtime settings and guarded lifecycle surface.',
    actions: ['read', 'restart', 'rebuild'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('settings_get', 'system', 'hidden', 'read', 'Settings reads belong on system.'),
      retiredAlias('self_restart', 'system', 'hidden', 'restart', 'Restart belongs on system.'),
      retiredAlias('self_rebuild', 'system', 'hidden', 'rebuild', 'Rebuild belongs on system.'),
    ],
  },
  {
    name: 'skill',
    domain: 'knowledge',
    exposure: 'core',
    description: 'Canonical managed-skill discovery and mutation surface.',
    actions: ['list', 'view', 'stats', 'create', 'update'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('skill_list', 'skill', 'hidden', 'list', 'Skill discovery belongs on skill.'),
      retiredAlias('skill_view', 'skill', 'hidden', 'view', 'Skill viewing belongs on skill.'),
    ],
  },
  {
    name: 'wiki',
    domain: 'knowledge',
    exposure: 'core',
    description: 'Canonical runtime-owned durable reference knowledge surface.',
    actions: ['list', 'read', 'search', 'write', 'import'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'schedule',
    domain: 'scheduler',
    exposure: 'core',
    description: 'Canonical schedule and heartbeat template surface.',
    actions: ['list', 'create', 'update', 'delete', 'run'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('schedule_task', 'schedule', 'hidden', 'create', 'Scheduled work belongs on schedule.'),
      retiredAlias('heartbeat_update_policy', 'schedule', 'hidden', 'update', 'Heartbeat policy changes belong on schedule.'),
    ],
  },
  {
    name: 'north_star',
    domain: 'orientation',
    exposure: 'extended',
    description: 'Canonical long-horizon guiding-intent surface.',
    actions: ['list', 'create', 'update', 'delete', 'reorder'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('north_star_list', 'north_star', 'hidden', 'list', 'North-star reads belong on north_star.'),
      retiredAlias('north_star_create', 'north_star', 'hidden', 'create', 'North-star creation belongs on north_star.'),
      retiredAlias('north_star_update', 'north_star', 'hidden', 'update', 'North-star updates belong on north_star.'),
      retiredAlias('north_star_delete', 'north_star', 'hidden', 'delete', 'North-star deletion belongs on north_star.'),
      retiredAlias('north_star_reorder', 'north_star', 'hidden', 'reorder', 'North-star ordering belongs on north_star.'),
    ],
  },
  {
    name: 'beads',
    domain: 'tracked_work',
    exposure: 'extended',
    description: 'Canonical tracked-work surface.',
    actions: ['ready', 'show', 'create', 'update', 'close', 'sync'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('issue_ready', 'beads', 'hidden', 'ready', 'Tracked-work reads belong on beads.'),
      retiredAlias('issue_show', 'beads', 'hidden', 'show', 'Tracked-work reads belong on beads.'),
      retiredAlias('issue_create', 'beads', 'hidden', 'create', 'Tracked-work creation belongs on beads.'),
      retiredAlias('issue_update', 'beads', 'hidden', 'update', 'Tracked-work updates belong on beads.'),
      retiredAlias('issue_close', 'beads', 'hidden', 'close', 'Tracked-work closure belongs on beads.'),
      retiredAlias('issue_sync', 'beads', 'hidden', 'sync', 'Tracked-work sync belongs on beads.'),
    ],
  },
  {
    name: 'notify',
    domain: 'notification',
    exposure: 'extended',
    description: 'Canonical notification surface.',
    actions: ['brief', 'send', 'approval_request'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('notify_operator', 'notify', 'hidden', 'brief', 'Operator notifications belong on notify.'),
    ],
  },
  {
    name: 'media',
    domain: 'media',
    exposure: 'extended',
    description: 'Canonical generic media generation, editing, and analysis surface.',
    actions: ['generate', 'edit', 'analyze'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('image_create', 'media', 'retired', 'generate', 'Image generation belongs on media.'),
      retiredAlias('image_edit', 'media', 'retired', 'edit', 'Image editing belongs on media.'),
      retiredAlias('image_analyze', 'media', 'retired', 'analyze', 'Image analysis belongs on media.'),
    ],
  },
  {
    name: 'selfie_create',
    domain: 'self_expression',
    exposure: 'extended',
    description: 'Canonical first-class self-expression image surface with appearance and saved-reference anchoring.',
    capabilityMetadata: { kind: 'static', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
  {
    name: 'subagent',
    domain: 'subagents',
    exposure: 'core',
    description: 'Canonical bounded-worker control plane.',
    actions: ['spawn', 'message', 'wait', 'cancel', 'status'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('spawn_subagent', 'subagent', 'retired', 'spawn', 'Bounded worker launch belongs on subagent.'),
    ],
  },
  {
    name: 'shard',
    domain: 'subagents',
    exposure: 'extended',
    description: 'Future canonical long-horizon shard control plane.',
    actions: ['spawn'],
    capabilityMetadata: { kind: 'external_policy', source: 'docs/tool-surface.md' },
    retiredAliases: [
      retiredAlias('spawn_shard', 'shard', 'hidden', 'spawn', 'Long-horizon shard launch belongs on shard.'),
    ],
  },
  {
    name: 'vault',
    domain: 'knowledge',
    exposure: 'extended',
    description: 'Legacy external Obsidian bridge surface, bounded as external source handling.',
    actions: ['write', 'read', 'search', 'daily'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [
      retiredAlias('vault_write', 'vault', 'hidden', 'write', 'Vault writes belong on vault.'),
      retiredAlias('vault_read', 'vault', 'hidden', 'read', 'Vault reads belong on vault.'),
      retiredAlias('vault_search', 'vault', 'hidden', 'search', 'Vault search belongs on vault.'),
      retiredAlias('vault_daily', 'vault', 'hidden', 'daily', 'Vault daily-note access belongs on vault.'),
    ],
  },
  {
    name: 'journal',
    domain: 'memory',
    exposure: 'core',
    description: 'Companion journal import/write surface.',
    actions: ['list', 'read', 'write', 'append', 'search'],
    capabilityMetadata: { kind: 'action_aware', source: CAPABILITIES_REQUIREMENTS },
    retiredAliases: [],
  },
];

const CANONICAL_BY_NAME = new Map(
  CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(entry => [entry.name, entry]),
);

const RETIRED_BY_NAME = new Map(
  CANONICAL_FIRST_PARTY_TOOL_SURFACES
    .flatMap(entry => entry.retiredAliases)
    .map(alias => [alias.alias, alias]),
);

export function listCanonicalToolSurfaces(): readonly CanonicalToolSurfaceEntry[] {
  return CANONICAL_FIRST_PARTY_TOOL_SURFACES;
}

export function getCanonicalToolSurface(name: string): CanonicalToolSurfaceEntry | undefined {
  return CANONICAL_BY_NAME.get(name);
}

export function isCanonicalFirstPartyToolName(name: string): boolean {
  return CANONICAL_BY_NAME.has(name);
}

export function getRetiredToolAlias(name: string): RetiredToolAlias | undefined {
  return RETIRED_BY_NAME.get(name);
}

export function isRetiredFirstPartyToolAlias(name: string): boolean {
  return RETIRED_BY_NAME.has(name);
}

export function isKnownFirstPartyToolSurfaceName(name: string): boolean {
  return isCanonicalFirstPartyToolName(name) || isRetiredFirstPartyToolAlias(name);
}

export function listRetiredToolAliases(): readonly RetiredToolAlias[] {
  return [...RETIRED_BY_NAME.values()];
}

export function assertNoRetiredFirstPartyToolAliases(
  toolNames: Iterable<string>,
  context: string,
): void {
  const retiredNames: string[] = [];
  for (const name of toolNames) {
    const retired = getRetiredToolAlias(name);
    if (retired && !retired.charterException) {
      retiredNames.push(`${name}->${retired.canonicalName}`);
    }
  }
  if (retiredNames.length > 0) {
    throw new Error(`${context} includes retired first-party tool aliases: ${retiredNames.join(', ')}`);
  }
}

export function assertNoModelFacingDriftGuardToolAliases(
  toolNames: Iterable<string>,
  context: string,
): void {
  const retiredNames: string[] = [];
  for (const name of toolNames) {
    if (!MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIAS_SET.has(name)) continue;
    const retired = getRetiredToolAlias(name);
    if (retired && !retired.charterException) {
      retiredNames.push(`${name}->${retired.canonicalName}`);
    }
  }
  if (retiredNames.length > 0) {
    throw new Error(`${context} includes retired first-party tool aliases: ${retiredNames.join(', ')}`);
  }
}
