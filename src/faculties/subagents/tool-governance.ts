import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import { textResultWithError } from '../../core/tools/results.js';
import { isRecord } from '../../shared/utils/types.js';
import type { SubagentMemoryAuditTrail } from './memory-governance.js';

/**
 * p0le — non-memory subagent tool governance (charter 6.11, Law 37).
 *
 * c7d governed the canonical `memory` surface; every other parent-catalog
 * tool still reached subagent loops verbatim, leaving core-authoritative
 * mutation surfaces (values, consent, concerns, companion-voice durable
 * content, skill self-modification) writable from a default-tier bounded
 * child. Core remains authoritative for identity, values, consent, and
 * trust truth, so the multiplexed surfaces that mix reads and mutations are
 * wrapped here: read actions pass through, every mutation is denied. Fail
 * closed — an omitted, unresolved, or unknown action is a denied action.
 *
 * Purely identity/purpose surfaces (`identity`, `north_star`) and the
 * contact/trust surface have no task-scoped read a bounded child needs and
 * are blocked at injection instead (BLOCKED_SUBAGENT_TOOL_NAMES in
 * faculty.ts). `scratchpad` stays fully available: bounded 24h ephemeral
 * working memory, dispositioned out of scope by the c7d review.
 */

export type SubagentToolCallKind = 'read' | 'mutation' | 'unknown' | 'unresolved';

export interface SubagentToolCallClassification {
  action: string | null;
  kind: SubagentToolCallKind;
}

export interface SubagentToolGovernancePolicy {
  /** Read actions surfaced in deny guidance. */
  readActionsHelp: string;
  /**
   * Classifies a call fail-closed: only 'read' passes through to the
   * underlying tool; everything else is denied.
   */
  classify(params: unknown): SubagentToolCallClassification;
}

export interface SubagentToolGovernanceContext {
  subagentId: string;
  subagentName: string;
  auditTrail: SubagentMemoryAuditTrail | null;
}

function resolveExplicitAction(params: unknown): string | null {
  if (!isRecord(params)) return null;
  if (typeof params.action !== 'string') return null;
  const normalized = params.action.trim();
  return normalized.length > 0 ? normalized : null;
}

function classifyByActionSets(
  action: string | null,
  reads: ReadonlySet<string>,
  mutations: ReadonlySet<string>,
): SubagentToolCallClassification {
  if (action === null) return { action: null, kind: 'unresolved' };
  if (reads.has(action)) return { action, kind: 'read' };
  if (mutations.has(action)) return { action, kind: 'mutation' };
  return { action, kind: 'unknown' };
}

// orient multiplexes core-memory block edits, the global values journal, the
// companion concern ledger, and the single global introspection consent
// policy — every one of those is core-authoritative truth.
const ORIENT_READ_ACTIONS: ReadonlySet<string> = new Set([
  'values_list',
  'list_concerns',
  'introspection_consent_get',
]);
const ORIENT_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'append',
  'replace',
  'reorient',
  'values_add',
  'values_update',
  'create_concern',
  'resolve_concern',
  'transition_concern',
  'introspection_consent_set',
  'introspection_turn_sensitivity_set',
]);

// journal notes are companion-voice durable content.
const JOURNAL_READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'read', 'search']);
const JOURNAL_MUTATION_ACTIONS: ReadonlySet<string> = new Set(['write', 'append']);

// wiki documents, wishes, projects, and wardrobe looks are companion-voice
// durable content; propose_shared_world additionally has external reach.
const WIKI_READ_ACTIONS: ReadonlySet<string> = new Set([
  'list',
  'read',
  'search',
  'semantic_search',
  'wish_list',
  'wish_read',
  'project_list',
  'project_read',
  'wardrobe_list',
  'wardrobe_read',
]);
const WIKI_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'write',
  'import',
  'propose_shared_world',
  'wish_create',
  'project_create',
  'project_update',
  'project_add_artifact',
  'project_share',
  'wardrobe_save',
  'wardrobe_revise',
]);

// skill create/update is a self-modification surface (prompt-injected skill
// packages); reads let a worker consult skills it may be asked to apply.
const SKILL_READ_ACTIONS: ReadonlySet<string> = new Set([
  'list',
  'skill_list',
  'view',
  'skill_view',
  'stats',
  'skill_stats',
]);
const SKILL_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'skill_create',
  'update',
  'skill_update',
]);

// vault notes are a companion self-modification surface; `daily` is
// read-or-append depending on whether content is supplied.
const VAULT_READ_ACTIONS: ReadonlySet<string> = new Set([
  'read',
  'vault_read',
  'search',
  'vault_search',
]);
const VAULT_MUTATION_ACTIONS: ReadonlySet<string> = new Set(['write', 'vault_write']);
const VAULT_DAILY_ACTIONS: ReadonlySet<string> = new Set(['daily', 'vault_daily']);

const ORIENT_POLICY: SubagentToolGovernancePolicy = {
  readActionsHelp: 'values_list, list_concerns, introspection_consent_get',
  classify(params) {
    return classifyByActionSets(
      resolveExplicitAction(params),
      ORIENT_READ_ACTIONS,
      ORIENT_MUTATION_ACTIONS,
    );
  },
};

const JOURNAL_POLICY: SubagentToolGovernancePolicy = {
  readActionsHelp: 'list, read, search',
  classify(params) {
    return classifyByActionSets(
      resolveExplicitAction(params),
      JOURNAL_READ_ACTIONS,
      JOURNAL_MUTATION_ACTIONS,
    );
  },
};

const WIKI_POLICY: SubagentToolGovernancePolicy = {
  readActionsHelp:
    'list, read, search, semantic_search, wish_list, wish_read, project_list, project_read, '
    + 'wardrobe_list, wardrobe_read',
  classify(params) {
    const explicit = resolveExplicitAction(params);
    if (explicit !== null || !isRecord(params)) {
      return classifyByActionSets(explicit, WIKI_READ_ACTIONS, WIKI_MUTATION_ACTIONS);
    }
    // Mirrors normalizeAction in faculties/wiki/tools.ts: an omitted action
    // only ever resolves to a read (search/read/list) or an error, so the
    // read defaults keep working from a subagent context.
    const hasQuery = typeof params.query === 'string' && params.query.trim().length > 0;
    const hasId = typeof params.id === 'string' && params.id.trim().length > 0;
    const hasWriteFields = typeof params.title === 'string' || typeof params.body === 'string';
    if (hasQuery) return { action: 'search', kind: 'read' };
    if (hasId && !hasWriteFields) return { action: 'read', kind: 'read' };
    if (!hasId && !hasWriteFields) return { action: 'list', kind: 'read' };
    return { action: null, kind: 'unresolved' };
  },
};

const SKILL_POLICY: SubagentToolGovernancePolicy = {
  readActionsHelp: 'list, view, stats',
  classify(params) {
    const explicit = resolveExplicitAction(params);
    if (explicit !== null || !isRecord(params)) {
      return classifyByActionSets(explicit, SKILL_READ_ACTIONS, SKILL_MUTATION_ACTIONS);
    }
    // Mirrors normalizeSkillAction in faculties/skills/tools.ts: an omitted
    // action is the list read only when no action-specific params are set.
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'includeSkipped'
      && key !== 'includeContent'
      && value !== undefined
    ));
    if (!hasNonListParams) return { action: 'list', kind: 'read' };
    return { action: null, kind: 'unresolved' };
  },
};

const VAULT_POLICY: SubagentToolGovernancePolicy = {
  readActionsHelp: 'read, search, daily (without content)',
  classify(params) {
    const explicit = resolveExplicitAction(params);
    if (!isRecord(params)) {
      return classifyByActionSets(explicit, VAULT_READ_ACTIONS, VAULT_MUTATION_ACTIONS);
    }
    if (explicit !== null) {
      if (VAULT_DAILY_ACTIONS.has(explicit)) {
        // daily appends when content is a string and reads otherwise
        // (executeVaultDaily in boundary/integrations/vault/tools.ts).
        return typeof params.content === 'string'
          ? { action: explicit, kind: 'mutation' }
          : { action: explicit, kind: 'read' };
      }
      return classifyByActionSets(explicit, VAULT_READ_ACTIONS, VAULT_MUTATION_ACTIONS);
    }
    // Mirrors normalizeVaultAction's omitted-action inference, which can
    // resolve to a write or daily-append — classify those as mutations.
    const hasName = typeof params.name === 'string';
    const hasContent = typeof params.content === 'string';
    const hasQuery = typeof params.query === 'string';
    const hasFolder = typeof params.folder === 'string';
    const hasMode = typeof params.mode === 'string';
    const hasLimit = typeof params.limit === 'number';
    if (hasQuery && !hasName && !hasContent && !hasFolder && !hasMode) {
      return { action: 'search', kind: 'read' };
    }
    if (hasName && hasContent) return { action: 'write', kind: 'mutation' };
    if (hasName && !hasContent && !hasQuery && !hasFolder && !hasMode && !hasLimit) {
      return { action: 'read', kind: 'read' };
    }
    if (!hasName && hasContent && !hasQuery && !hasFolder && !hasMode && !hasLimit) {
      return { action: 'daily', kind: 'mutation' };
    }
    return { action: null, kind: 'unresolved' };
  },
};

/**
 * Core-authoritative multiplexed tools that only reach a subagent loop
 * behind a read-only governance wrapper (see resolveInjectedTools).
 */
export const GOVERNED_SUBAGENT_TOOL_POLICIES: ReadonlyMap<string, SubagentToolGovernancePolicy> =
  new Map([
    ['orient', ORIENT_POLICY],
    ['journal', JOURNAL_POLICY],
    ['wiki', WIKI_POLICY],
    ['skill', SKILL_POLICY],
    ['vault', VAULT_POLICY],
  ]);

/**
 * Wraps a core-authoritative multiplexed tool for injection into a subagent
 * loop: read actions pass through unchanged, mutations are denied and
 * audit-trailed. There is no opt-in or elevation for these surfaces — a
 * bounded child proposes changes in its final result for core to act on.
 */
export function createGovernedSubagentTool(
  tool: AgentTool<any>,
  policy: SubagentToolGovernancePolicy,
  context: SubagentToolGovernanceContext,
): AgentTool<any> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const classification = policy.classify(params);
      if (classification.kind === 'read') {
        return tool.execute(toolCallId, params as Parameters<typeof tool.execute>[1], signal);
      }
      return denyGovernedCall(tool, policy, context, toolCallId, classification);
    },
  };
}

function denyGovernedCall(
  tool: AgentTool<any>,
  policy: SubagentToolGovernancePolicy,
  context: SubagentToolGovernanceContext,
  toolCallId: string,
  classification: SubagentToolCallClassification,
): AgentToolResult<{ isError?: boolean }> {
  const reason = classification.kind === 'mutation'
    ? 'mutation_not_permitted'
    : classification.kind === 'unknown'
      ? 'unknown_action'
      : 'action_unresolved';
  context.auditTrail?.append('subagent.tool.mutation.denied', {
    subagentId: context.subagentId,
    subagentName: context.subagentName,
    toolName: tool.name,
    toolCallId,
    action: classification.action ?? 'unknown',
    reason,
  });
  const summary = classification.kind === 'mutation'
    ? `Error: ${tool.name} action "${classification.action}" mutates companion-canonical state and is `
      + 'not available from a subagent context (fail closed).'
    : classification.kind === 'unknown'
      ? `Error: unrecognized ${tool.name} action "${classification.action}" from a subagent context is `
        + 'denied (fail closed).'
      : `Error: ${tool.name} calls from a subagent context must resolve to an explicit read action `
        + '(fail closed).';
  return textResultWithError(
    `${summary} Read actions available: ${policy.readActionsHelp}. `
    + 'Include any proposed change in your final result for core to review and apply.',
    true,
    { errorClass: 'policy_blocked', retryHint: 'do_not_retry' },
  );
}
