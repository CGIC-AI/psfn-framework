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
  schedule_task: 'identity.write.runtime',
  session_new: 'identity.write.runtime',
  session_list: 'identity.read',
  session_resume: 'identity.write.runtime',
  self_rebuild: 'lifecycle.rebuild',
  self_restart: 'lifecycle.restart',
  settings_get: 'identity.read',
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
  const annotated = (tool as AgentTool<any> & CapabilityAnnotatedTool).requiredCapability;
  if (annotated) {
    if (typeof annotated === 'function') {
      return normalizeRequirement(annotated(toRecord(params)));
    }
    return normalizeRequirement(annotated);
  }

  const fallback = STATIC_TOOL_REQUIREMENTS[tool.name];
  return normalizeRequirement(fallback);
}
