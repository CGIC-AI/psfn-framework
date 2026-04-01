import type { AgentTool } from '@mariozechner/pi-agent-core';
import { isRecord } from '../utils/types.js';
import type { CapabilityToken } from './tokens.js';

export type CapabilityRequirement = CapabilityToken | readonly CapabilityToken[];
export type CapabilityRequirementResolver = (
  params: Record<string, unknown>,
) => CapabilityRequirement | null | undefined;
export type CapabilityRequirementInput = CapabilityRequirement | CapabilityRequirementResolver;

interface CapabilityAnnotatedTool {
  requiredCapability?: CapabilityRequirementInput;
}

const MEMORY_FAIL_CLOSED_REQUIREMENTS = [
  'identity.read',
  'memory.write',
  'memory.delete',
] as const satisfies readonly CapabilityToken[];

const NORTH_STAR_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'identity.read',
  'identity.write.runtime',
] as const;

const SCRATCHPAD_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'identity.read',
  'memory.write',
] as const;

const FILESYSTEM_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'git.read',
  'git.write',
] as const;

const REPO_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'git.read',
  'git.write',
] as const;

const IDENTITY_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'identity.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
] as const;

const SESSION_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'identity.read',
  'identity.write.runtime',
] as const;

const SHELL_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'repl.execute',
] as const;

function resolveUnifiedMemoryRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case 'search':
      return 'identity.read';
    case 'write':
    case 'import':
      return 'memory.write';
    case 'redact':
    case 'delete':
    case 'restore':
      return 'memory.delete';
    default:
      return MEMORY_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveUnifiedNorthStarRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'list':
      return 'identity.read';
    case 'create':
    case 'update':
    case 'delete':
    case 'reorder':
      return 'identity.write.runtime';
    default:
      return NORTH_STAR_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveScratchpadRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case 'list':
      return 'identity.read';
    case 'add':
    case 'replace':
    case 'append':
    case 'remove':
      return 'memory.write';
    default:
      return SCRATCHPAD_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveFilesystemRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (!action) {
    return Object.keys(params).length === 0 ? 'git.read' : FILESYSTEM_FAIL_CLOSED_REQUIREMENTS;
  }

  switch (action) {
    case 'list':
    case 'read':
    case 'search':
      return 'git.read';
    case 'write':
    case 'edit':
      return 'git.write';
    default:
      return FILESYSTEM_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveRepoRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (!action) {
    return Object.keys(params).length === 0 ? 'git.read' : REPO_FAIL_CLOSED_REQUIREMENTS;
  }

  switch (action) {
    case 'inspect':
      return 'git.read';
    case 'patch':
    case 'branch':
    case 'commit':
    case 'publish':
      return 'git.write';
    default:
      return REPO_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveUnifiedIdentityRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (!action) {
    return Object.keys(params).length === 0 ? 'identity.read' : IDENTITY_FAIL_CLOSED_REQUIREMENTS;
  }

  switch (action) {
    case 'list_layers':
    case 'get_layer':
    case 'diff_layer':
    case 'history':
      return 'identity.read';
    case 'update_persona':
      return 'identity.write.runtime';
    case 'update_layer':
    case 'rollback_layer':
    case 'toggle_layer': {
      const layerId = typeof params.layer_id === 'string' ? params.layer_id.trim() : '';
      if (!layerId) return IDENTITY_FAIL_CLOSED_REQUIREMENTS;
      return 'identity.write.runtime';
    }
    case 'commit_stage':
    case 'cancel_stage':
      return 'identity.write.runtime';
    default:
      return IDENTITY_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveUnifiedSessionRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (!action) {
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'limit'
      && value !== undefined
    ));
    return hasNonListParams ? SESSION_FAIL_CLOSED_REQUIREMENTS : 'identity.read';
  }

  switch (action) {
    case 'list':
    case 'session_list':
    case 'search':
    case 'session_search':
    case 'grep':
    case 'session_grep':
      return 'identity.read';
    case 'new':
    case 'session_new':
    case 'resume':
    case 'session_resume':
    case 'start_focus':
    case 'focus_start':
    case 'complete_focus':
    case 'focus_complete':
      return 'identity.write.runtime';
    default:
      return SESSION_FAIL_CLOSED_REQUIREMENTS;
  }
}

function resolveUnifiedShellRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'exec':
      return 'repl.execute';
    default:
      return SHELL_FAIL_CLOSED_REQUIREMENTS;
  }
}

const STATIC_TOOL_REQUIREMENTS: Readonly<Record<string, CapabilityRequirement>> = {
  contact_list: 'identity.read',
  contact_lookup: 'identity.read',
  contact_note: 'identity.write.runtime',
  contact_link_identity: 'identity.write.runtime',
  contact_set_channel_privacy: 'identity.write.runtime',
  contact_set_trust: 'identity.write.runtime',
  heartbeat_get_policy: 'identity.read',
  heartbeat_run_template: 'identity.write.runtime',
  heartbeat_update_policy: 'identity.write.runtime',
  identity_changelog: 'identity.read',
  identity_diff: 'identity.read',
  memory_import_batch: 'memory.write',
  memory_redact: 'memory.delete',
  memory_delete: 'memory.delete',
  undo_memory_delete: 'memory.delete',
  memory_write: 'memory.write',
  notify_operator: 'external.web',
  toolset: 'identity.read',
  promoted_tools_list: 'identity.read',
  promoted_tools_add: 'identity.write.runtime',
  promoted_tools_remove: 'identity.write.runtime',
  promoted_tools_swap: 'identity.write.runtime',
  prompt_layer_get: 'identity.read',
  prompt_layer_list: 'identity.read',
  prompt_layer_rollback: 'identity.write.runtime',
  prompt_layer_toggle: 'identity.write.runtime',
  prompt_layer_update: 'identity.write.runtime',
  north_star: 'identity.write.runtime',
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
  media: 'external.web',
  schedule_task: 'identity.write.runtime',
  session_new: 'identity.write.runtime',
  session_grep: 'identity.read',
  session_list: 'identity.read',
  session_search: 'identity.read',
  session_resume: 'identity.write.runtime',
  self_rebuild: 'lifecycle.rebuild',
  self_restart: 'lifecycle.restart',
  settings_get: 'identity.read',
  subagent: 'subagent.spawn',
  spawn_shard: 'shard.spawn',
  think: 'repl.execute',
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

export function withCapabilityRequirement<T extends AgentTool<any>>(
  tool: T,
  requirement: CapabilityRequirementInput,
): T {
  (tool as T & CapabilityAnnotatedTool).requiredCapability = requirement;
  return tool;
}

export function resolveToolRequiredCapabilities(
  tool: AgentTool<any>,
  params: unknown,
): CapabilityToken[] {
  if (tool.name === 'memory') {
    return normalizeRequirement(resolveUnifiedMemoryRequirement(toRecord(params)));
  }
  if (tool.name === 'scratchpad') {
    return normalizeRequirement(resolveScratchpadRequirement(toRecord(params)));
  }

  if (tool.name === 'fs') {
    return normalizeRequirement(resolveFilesystemRequirement(toRecord(params)));
  }

  if (tool.name === 'repo') {
    return normalizeRequirement(resolveRepoRequirement(toRecord(params)));
  }

  if (tool.name === 'north_star') {
    return normalizeRequirement(resolveUnifiedNorthStarRequirement(toRecord(params)));
  }

  const annotated = (tool as AgentTool<any> & CapabilityAnnotatedTool).requiredCapability;
  if (annotated) {
    if (typeof annotated === 'function') {
      return normalizeRequirement(annotated(toRecord(params)));
    }
    return normalizeRequirement(annotated);
  }

  if (tool.name === 'identity') {
    return normalizeRequirement(resolveUnifiedIdentityRequirement(toRecord(params)));
  }

  if (tool.name === 'session') {
    return normalizeRequirement(resolveUnifiedSessionRequirement(toRecord(params)));
  }

  if (tool.name === 'shell') {
    return normalizeRequirement(resolveUnifiedShellRequirement(toRecord(params)));
  }

  const fallback = STATIC_TOOL_REQUIREMENTS[tool.name];
  return normalizeRequirement(fallback);
}
