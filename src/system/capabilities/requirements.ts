import type { AgentTool } from '@mariozechner/pi-agent-core';
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

function resolveUnifiedToolRequirement(
  toolName: string,
  params: Record<string, unknown>,
): CapabilityRequirement | null {
  const action = normalizeAction(params);

  switch (toolName) {
    case 'system':
      if (action === 'read' || action === 'settings_get' || action === null) return 'identity.read';
      if (action === 'restart' || action === 'self_restart') return 'lifecycle.restart';
      if (action === 'rebuild' || action === 'self_rebuild') return 'lifecycle.rebuild';
      return ['identity.read', 'lifecycle.restart', 'lifecycle.rebuild'];
    case 'identity':
      if (action === 'list_layers' || action === 'get_layer' || action === 'diff_layer' || action === 'history' || action === null) {
        return 'identity.read';
      }
      if (action === 'update_persona') return 'identity.write.runtime';
      if (action === 'update_layer' || action === 'rollback_layer' || action === 'toggle_layer' || action === 'commit_stage' || action === 'cancel_stage') {
        return ['identity.write.runtime', 'identity.write.base', 'identity.write.operator'];
      }
      return ['identity.read', 'identity.write.runtime', 'identity.write.base', 'identity.write.operator'];
    case 'memory':
      if (action === 'delete' || action === 'restore' || action === 'redact') return 'memory.delete';
      if (action === 'search' || action === 'list' || action === 'read' || action === 'get') return 'identity.read';
      if (action === 'write' || action === 'memory_write' || action === 'add' || action === 'patch' || action === 'import') {
        return 'memory.write';
      }
      return ['identity.read', 'memory.write', 'memory.delete'];
    case 'north_star':
      if (action === 'list' || action === 'read' || action === 'get') return 'identity.read';
      if (action === 'create' || action === 'update' || action === 'delete' || action === 'reorder') {
        return 'identity.write.runtime';
      }
      return ['identity.read', 'identity.write.runtime'];
    case 'shell':
      return 'repl.execute';
    case 'scratchpad':
      if (action === 'list' || action === 'read' || action === 'get' || action === 'scratchpad_read') return 'identity.read';
      if (action === 'add' || action === 'write' || action === 'update' || action === 'delete' || action === 'clear') {
        return 'memory.write';
      }
      return ['identity.read', 'memory.write'];
    case 'orient':
      if (action === 'values_list' || action === 'list_concerns') return 'identity.read';
      if (
        action === 'append'
        || action === 'replace'
        || action === 'reorient'
        || action === 'create_concern'
        || action === 'resolve_concern'
      ) {
        return 'identity.write.runtime';
      }
      return ['identity.read', 'identity.write.runtime'];
    case 'session':
      if (action === 'list' || action === 'search' || action === 'read' || action === 'grep' || action === 'session_grep') {
        return 'identity.read';
      }
      if (
        action === 'new'
        || action === 'resume'
        || action === 'session_resume'
        || action === 'start_focus'
        || action === 'complete_focus'
      ) {
        return 'identity.write.runtime';
      }
      return ['identity.read', 'identity.write.runtime'];
    case 'vault': {
      if (action === 'read' || action === 'search' || action === 'vault_search') return 'identity.read';
      if (action === 'write' || action === 'daily' || action === 'vault_write' || action === 'vault_daily') {
        return 'identity.write.runtime';
      }
      const looksAmbiguousRead = typeof params.query === 'string' && params.query.trim().length > 0;
      const looksAmbiguousWrite = typeof params.name === 'string' && params.name.trim().length > 0;
      if (looksAmbiguousRead && looksAmbiguousWrite) {
        return ['identity.read', 'identity.write.runtime'];
      }
      return ['identity.read', 'identity.write.runtime'];
    }
    case 'fs':
      if (action === 'write' || action === 'edit') return 'git.write';
      if (action === 'read' || action === 'list' || action === 'search' || action === null) return 'git.read';
      return ['git.read', 'git.write'];
    case 'repo':
      if (
        action === 'patch'
        || action === 'branch'
        || action === 'create_branch'
        || action === 'commit'
        || action === 'publish'
        || action === 'open_pr'
      ) {
        return 'git.write';
      }
      if (action === 'inspect' || action === 'status' || action === 'diff' || action === null) return 'git.read';
      return ['git.read', 'git.write'];
    case 'beads':
      if (action === null || action === 'ready' || action === 'issue_ready' || action === 'show' || action === 'issue_show') return 'issue.read';
      if (action === 'create' || action === 'issue_create' || action === 'update' || action === 'issue_update') return 'issue.write';
      if (action === 'close' || action === 'issue_close' || action === 'sync' || action === 'issue_sync') return 'issue.close';
      return ['issue.read', 'issue.write', 'issue.close'];
    case 'notify':
      if (action === 'brief' || action === 'notify_operator' || action === 'approval_request') return 'external.web';
      if (action === 'send') {
        const channel = typeof params.delivery_channel === 'string'
          ? params.delivery_channel.trim()
          : '';
        if (channel === 'discord') return 'external.discord';
        if (channel === 'email') return 'external.email';
        return ['external.discord', 'external.email'];
      }
      return ['external.web', 'external.discord', 'external.email'];
    default:
      return null;
  }
}

const STATIC_TOOL_REQUIREMENTS: Readonly<Record<string, CapabilityRequirement>> = {
  contact: ['identity.read', 'identity.write.runtime'],
  contact_list: 'identity.read',
  contact_lookup: 'identity.read',
  contact_note: 'identity.write.runtime',
  contact_link_identity: 'identity.write.runtime',
  contact_set_channel_privacy: 'identity.write.runtime',
  contact_set_trust: 'identity.write.runtime',
  identity_changelog: 'identity.read',
  identity_diff: 'identity.read',
  memory_import_batch: 'memory.write',
  memory_redact: 'memory.delete',
  memory_delete: 'memory.delete',
  undo_memory_delete: 'memory.delete',
  memory_patch: 'memory.write',
  memory_write: 'memory.write',
  scratchpad_read: 'identity.read',
  scratchpad_write: 'memory.write',
  notify_operator: 'external.web',
  promoted_tools_list: 'identity.read',
  promoted_tools_add: 'identity.write.runtime',
  promoted_tools_remove: 'identity.write.runtime',
  promoted_tools_swap: 'identity.write.runtime',
  prompt_layer_get: 'identity.read',
  prompt_layer_list: 'identity.read',
  prompt_layer_rollback: 'identity.write.runtime',
  prompt_layer_toggle: 'identity.write.runtime',
  prompt_layer_update: 'identity.write.runtime',
  north_star_list: 'identity.read',
  north_star_create: 'identity.write.runtime',
  north_star_update: 'identity.write.runtime',
  north_star_delete: 'identity.write.runtime',
  north_star_reorder: 'identity.write.runtime',
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
  image_create: 'external.web',
  image_edit: 'external.web',
  image_analyze: 'external.web',
  session_new: 'identity.write.runtime',
  session_grep: 'identity.read',
  session_list: 'identity.read',
  session_search: 'identity.read',
  session_resume: 'identity.write.runtime',
  self_rebuild: 'lifecycle.rebuild',
  self_restart: 'lifecycle.restart',
  settings_get: 'identity.read',
  spawn_subagent: 'shard.spawn',
  analysis_workbench: 'repl.execute',
  web: 'external.web',
  web_fetch: 'external.web',
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
  const normalizedParams = toRecord(params);
  const annotated = (tool as AgentTool<any> & CapabilityAnnotatedTool).requiredCapability;
  if (annotated) {
    if (typeof annotated === 'function') {
      return normalizeRequirement(annotated(normalizedParams));
    }
    return normalizeRequirement(annotated);
  }

  const unifiedRequirement = resolveUnifiedToolRequirement(tool.name, normalizedParams);
  if (unifiedRequirement) {
    return normalizeRequirement(unifiedRequirement);
  }

  const fallback = STATIC_TOOL_REQUIREMENTS[tool.name];
  return normalizeRequirement(fallback);
}
