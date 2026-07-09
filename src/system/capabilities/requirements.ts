import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateAgentTool } from '../../shared/contracts/agent-tools.js';
import { isRecord } from '../../shared/utils/types.js';
import type { CapabilityToken } from './tokens.js';

export type CapabilityRequirement = CapabilityToken | readonly CapabilityToken[];
export type CapabilityRequirementResolver = (
  params: Record<string, unknown>,
) => CapabilityRequirement | null | undefined;
export type CapabilityRequirementInput = CapabilityRequirement | CapabilityRequirementResolver;

interface CapabilityAnnotatedTool {
  requiredCapability?: CapabilityRequirementInput;
}

function normalizeAction(params: Record<string, unknown>): string | null {
  const action = params.action;
  if (typeof action !== 'string') return null;
  const normalized = action.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

type UnifiedToolRequirementResolver = (
  action: string | null,
  params: Record<string, unknown>,
) => CapabilityRequirement | null;

const IDENTITY_READ_RUNTIME_WRITE = ['identity.read', 'identity.write.runtime'] as const;
const NO_CAPABILITY_REQUIREMENT = [] as const;
const IDENTITY_LAYER_WRITE_REQUIREMENTS = [
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
] as const;
const IDENTITY_LAYER_REQUIREMENTS = [
  'identity.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
] as const;
const GIT_READ_WRITE = ['git.read', 'git.write'] as const;
const ISSUE_REQUIREMENTS = ['issue.read', 'issue.write', 'issue.close'] as const;
const LIFECYCLE_REQUIREMENTS = ['internal.read', 'lifecycle.restart', 'lifecycle.rebuild'] as const;
const MEMORY_REQUIREMENTS = ['identity.read', 'memory.write', 'memory.delete'] as const;
const NOTIFY_REQUIREMENTS = ['external.web', 'external.discord', 'external.email'] as const;

function actionIn(action: string | null, actions: ReadonlySet<string>): boolean {
  return action !== null && actions.has(action);
}

const SYSTEM_READ_ACTIONS = new Set(['read', 'settings_get']);
const SYSTEM_RESTART_ACTIONS = new Set(['restart', 'self_restart']);
const SYSTEM_REBUILD_ACTIONS = new Set(['rebuild', 'self_rebuild']);

function resolveSystemRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, SYSTEM_READ_ACTIONS)) return 'internal.read';
  if (actionIn(action, SYSTEM_RESTART_ACTIONS)) return 'lifecycle.restart';
  if (actionIn(action, SYSTEM_REBUILD_ACTIONS)) return 'lifecycle.rebuild';
  return LIFECYCLE_REQUIREMENTS;
}

const IDENTITY_READ_ACTIONS = new Set(['list_layers', 'get_layer', 'diff_layer', 'history']);
const IDENTITY_LAYER_WRITE_ACTIONS = new Set([
  'update_layer',
  'rollback_layer',
  'toggle_layer',
  'commit_stage',
  'cancel_stage',
]);

function resolveIdentityRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, IDENTITY_READ_ACTIONS)) return 'identity.read';
  if (action === 'update_persona') return 'identity.write.runtime';
  if (actionIn(action, IDENTITY_LAYER_WRITE_ACTIONS)) return IDENTITY_LAYER_WRITE_REQUIREMENTS;
  return IDENTITY_LAYER_REQUIREMENTS;
}

const MEMORY_READ_ACTIONS = new Set(['search', 'census', 'exists', 'timeline', 'list', 'read', 'get']);
const MEMORY_WRITE_ACTIONS = new Set(['write', 'add', 'patch', 'import']);
const MEMORY_DELETE_ACTIONS = new Set(['delete', 'restore', 'redact']);

function resolveMemoryRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, MEMORY_DELETE_ACTIONS)) return 'memory.delete';
  if (actionIn(action, MEMORY_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, MEMORY_WRITE_ACTIONS)) return 'memory.write';
  return MEMORY_REQUIREMENTS;
}

const NORTH_STAR_READ_ACTIONS = new Set(['list', 'read', 'get']);
const NORTH_STAR_WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'reorder']);

function resolveNorthStarRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, NORTH_STAR_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, NORTH_STAR_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const SCRATCHPAD_READ_ACTIONS = new Set(['list', 'read', 'get']);
const SCRATCHPAD_WRITE_ACTIONS = new Set([
  'add',
  'replace',
  'append',
  'remove',
  'write',
  'update',
  'delete',
  'clear',
]);
const SCRATCHPAD_REQUIREMENTS = ['identity.read', 'memory.write'] as const;

function resolveScratchpadRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, SCRATCHPAD_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, SCRATCHPAD_WRITE_ACTIONS)) return 'memory.write';
  return SCRATCHPAD_REQUIREMENTS;
}

const CONTACT_WRITE_ACTIONS = new Set([
  'note',
  'set_trust',
  'propose_trust',
  'link_identity',
  'set_channel_privacy',
  'set_machine_intelligence',
  'block',
  'unblock',
]);

function resolveContactRequirement(
  action: string | null,
  params: Record<string, unknown>,
): CapabilityRequirement {
  const parameterNames = Object.keys(params);
  const legacyLookupShape = action === null
    && (
      parameterNames.length === 0
      || (parameterNames.length === 1 && typeof params.contactId === 'string')
    );
  if (legacyLookupShape || action === 'list' || action === 'lookup') return 'identity.read';
  if (actionIn(action, CONTACT_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const ORIENT_READ_ACTIONS = new Set(['values_list', 'list_concerns']);
const ORIENT_WRITE_ACTIONS = new Set([
  'append',
  'replace',
  'reorient',
  'values_add',
  'values_update',
  'create_concern',
  'resolve_concern',
  'transition_concern',
]);

function resolveOrientRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, ORIENT_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, ORIENT_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const SESSION_READ_ACTIONS = new Set(['list', 'search', 'read', 'grep']);
const SESSION_WRITE_ACTIONS = new Set(['new', 'resume', 'wake_return', 'start_focus', 'complete_focus']);

function resolveSessionRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, SESSION_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, SESSION_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const SKILL_READ_ACTIONS = new Set(['list', 'skill_list', 'view', 'skill_view', 'stats', 'skill_stats']);
const SKILL_WRITE_ACTIONS = new Set(['create', 'skill_create', 'update', 'skill_update']);

function resolveSkillRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, SKILL_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, SKILL_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

function resolveSubagentRequirement(action: string | null): CapabilityRequirement {
  if (action === 'status' || action === 'wait') return 'identity.read';
  if (action === null || action === 'spawn' || action === 'message' || action === 'cancel') {
    return 'shard.spawn';
  }
  return ['identity.read', 'shard.spawn'];
}

const VAULT_READ_ACTIONS = new Set(['read', 'search', 'vault_search']);
const VAULT_WRITE_ACTIONS = new Set(['write', 'daily', 'vault_write', 'vault_daily']);

function resolveVaultRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, VAULT_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, VAULT_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const FS_READ_ACTIONS = new Set(['read', 'list', 'search']);
const FS_WRITE_ACTIONS = new Set(['write', 'edit']);

function resolveFsRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, FS_WRITE_ACTIONS)) return 'git.write';
  if (action === null || actionIn(action, FS_READ_ACTIONS)) return 'git.read';
  return GIT_READ_WRITE;
}

const JOURNAL_READ_ACTIONS = new Set(['list', 'read', 'search']);
const JOURNAL_WRITE_ACTIONS = new Set(['write', 'append']);

function resolveJournalRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, JOURNAL_READ_ACTIONS)) return 'identity.read';
  if (actionIn(action, JOURNAL_WRITE_ACTIONS)) return 'identity.write.runtime';
  return IDENTITY_READ_RUNTIME_WRITE;
}

const REPO_READ_ACTIONS = new Set(['inspect', 'status', 'diff']);
const REPO_WRITE_ACTIONS = new Set(['patch', 'branch', 'create_branch', 'commit', 'publish', 'open_pr']);

function resolveRepoRequirement(action: string | null): CapabilityRequirement {
  if (actionIn(action, REPO_WRITE_ACTIONS)) return 'git.write';
  if (action === null || actionIn(action, REPO_READ_ACTIONS)) return 'git.read';
  return GIT_READ_WRITE;
}

const BEADS_READ_ACTIONS = new Set(['ready', 'issue_ready', 'show', 'issue_show']);
const BEADS_WRITE_ACTIONS = new Set(['create', 'issue_create', 'update', 'issue_update']);
const BEADS_CLOSE_ACTIONS = new Set(['close', 'issue_close', 'sync', 'issue_sync']);

function resolveBeadsRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, BEADS_READ_ACTIONS)) return 'issue.read';
  if (actionIn(action, BEADS_WRITE_ACTIONS)) return 'issue.write';
  if (actionIn(action, BEADS_CLOSE_ACTIONS)) return 'issue.close';
  return ISSUE_REQUIREMENTS;
}

// `move` (vinz.26) is deliberate VIRTUAL navigation — it gates read-tier with
// perceive/list, not with effector control (locations decision 12 / s10wm).
const WORLD_READ_ACTIONS = new Set(['perceive', 'list', 'move']);
const WORLD_CONTROL_ACTIONS = new Set(['control']);
const WORLD_REQUIREMENTS = ['world.read', 'world.control'] as const;

function resolveWorldRequirement(action: string | null): CapabilityRequirement {
  if (action === null || actionIn(action, WORLD_READ_ACTIONS)) return 'world.read';
  if (actionIn(action, WORLD_CONTROL_ACTIONS)) return 'world.control';
  return WORLD_REQUIREMENTS;
}

function resolveNotifyRequirement(
  action: string | null,
  params: Record<string, unknown>,
): CapabilityRequirement {
  if (action === 'brief' || action === 'notify_operator' || action === 'approval_request') {
    return 'external.web';
  }
  if (action !== 'send') return NOTIFY_REQUIREMENTS;

  const channel = typeof params.delivery_channel === 'string'
    ? params.delivery_channel.trim()
    : '';
  if (channel === 'discord') return 'external.discord';
  if (channel === 'email') return 'external.email';
  return ['external.discord', 'external.email'];
}

const UNIFIED_TOOL_REQUIREMENT_RESOLVERS: Readonly<Partial<Record<string, UnifiedToolRequirementResolver>>> = {
  system: (action) => resolveSystemRequirement(action),
  identity: (action) => resolveIdentityRequirement(action),
  memory: (action) => resolveMemoryRequirement(action),
  north_star: (action) => resolveNorthStarRequirement(action),
  shell: () => 'repl.execute',
  scratchpad: (action) => resolveScratchpadRequirement(action),
  contact: resolveContactRequirement,
  orient: (action) => resolveOrientRequirement(action),
  session: (action) => resolveSessionRequirement(action),
  skill: (action) => resolveSkillRequirement(action),
  subagent: (action) => resolveSubagentRequirement(action),
  generate_image: () => NO_CAPABILITY_REQUIREMENT,
  selfie_create: () => NO_CAPABILITY_REQUIREMENT,
  vault: (action) => resolveVaultRequirement(action),
  fs: (action) => resolveFsRequirement(action),
  repo: (action) => resolveRepoRequirement(action),
  beads: (action) => resolveBeadsRequirement(action),
  world: (action) => resolveWorldRequirement(action),
  notify: resolveNotifyRequirement,
  journal: (action) => resolveJournalRequirement(action),
};

const STATIC_TOOL_REQUIREMENTS: Readonly<Record<string, CapabilityRequirement>> = {
  identity_changelog: 'identity.read',
  identity_diff: 'identity.read',
  notify_operator: 'external.web',
  prompt_layer_get: 'identity.read',
  prompt_layer_list: 'identity.read',
  prompt_layer_rollback: 'identity.write.runtime',
  prompt_layer_toggle: 'identity.write.runtime',
  prompt_layer_update: 'identity.write.runtime',
  repo_apply_patch: 'git.write',
  repo_commit: 'git.write',
  repo_create_branch: 'git.write',
  repo_diff: 'git.read',
  repo_open_pr: 'git.write',
  repo_status: 'git.read',
  issue_ready: 'issue.read',
  issue_show: 'issue.read',
  issue_create: 'issue.write',
  issue_update: 'issue.write',
  issue_close: 'issue.close',
  issue_sync: 'issue.close',
  settings_get: 'internal.read',
  self_status: 'internal.read',
  response_control: 'identity.read',
  analysis_workbench: 'repl.execute',
  // tool_search is a pure non-default-catalog discovery surface. It is
  // legitimately unrestricted, but it must DECLARE that explicitly so it is
  // distinguishable from a tool that has no requirement path at all (which
  // fails closed). An explicit empty declaration keeps it allowed at every tier.
  tool_search: NO_CAPABILITY_REQUIREMENT,
  web: NO_CAPABILITY_REQUIREMENT,
  web_fetch: NO_CAPABILITY_REQUIREMENT,
  vault_write: 'identity.write.runtime',
  vault_read: 'identity.read',
  vault_search: 'identity.read',
  vault_daily: 'identity.write.runtime',
};

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeRequirement(input: CapabilityRequirement | null | undefined): CapabilityToken[] {
  if (!input) return [];
  if (Array.isArray(input)) return [...new Set(input)];
  return [input as CapabilityToken];
}

export function withCapabilityRequirement<T extends SubstrateAgentTool>(
  tool: T,
  requirement: CapabilityRequirementInput,
): T {
  (tool as T & CapabilityAnnotatedTool).requiredCapability = requirement;
  return tool;
}

export interface ToolCapabilityRequirementResolution {
  /**
   * True when the tool DECLARES a capability-requirement path: an explicit
   * annotation, a unified action-aware resolver, or a static requirement entry
   * (an explicit "no requirement" declaration counts). False only when the tool
   * has no requirement path at all — that case must fail closed rather than be
   * treated as "unrestricted", because an empty requirement set is allowed at
   * every tier (02-M2).
   */
  declared: boolean;
  tokens: CapabilityToken[];
}

export function resolveToolCapabilityRequirement(
  tool: AgentTool<any>,
  params: unknown,
): ToolCapabilityRequirementResolution {
  const normalizedParams = toRecord(params);
  const annotated = (tool as AgentTool<any> & CapabilityAnnotatedTool).requiredCapability;
  if (annotated !== undefined) {
    if (typeof annotated === 'function') {
      return { declared: true, tokens: normalizeRequirement(annotated(normalizedParams)) };
    }
    return { declared: true, tokens: normalizeRequirement(annotated) };
  }

  const resolver = UNIFIED_TOOL_REQUIREMENT_RESOLVERS[tool.name];
  if (resolver) {
    return {
      declared: true,
      tokens: normalizeRequirement(resolver(normalizeAction(normalizedParams), normalizedParams)),
    };
  }

  if (Object.prototype.hasOwnProperty.call(STATIC_TOOL_REQUIREMENTS, tool.name)) {
    return { declared: true, tokens: normalizeRequirement(STATIC_TOOL_REQUIREMENTS[tool.name]) };
  }

  return { declared: false, tokens: [] };
}

export function resolveToolRequiredCapabilities(
  tool: AgentTool<any>,
  params: unknown,
): CapabilityToken[] {
  return resolveToolCapabilityRequirement(tool, params).tokens;
}

/**
 * Whether the tool declares any capability-requirement path. A tool that does
 * not is refused fail-closed at gating time (and, for first-party tools, at
 * registration time) instead of being silently allowed at every tier.
 */
export function toolHasDeclaredCapabilityRequirement(tool: AgentTool<any>): boolean {
  return resolveToolCapabilityRequirement(tool, {}).declared;
}

/**
 * Registration-time guard: throws (loud, fail-closed) when a tool has no
 * declared capability requirement. Legitimately unrestricted tools must carry
 * an explicit "no requirement" declaration to satisfy this.
 */
export function assertToolCapabilityRequirementDeclared(tool: AgentTool<any>): void {
  if (toolHasDeclaredCapabilityRequirement(tool)) return;
  throw new Error(
    `Tool "${tool.name}" has no declared capability requirement. Every gated tool must declare one `
    + `(an annotation, a unified action-aware resolver, or a static requirement entry); use an explicit `
    + `empty declaration for legitimately unrestricted tools. Refusing to register a tool that would `
    + `otherwise be allowed at every capability tier.`,
  );
}
