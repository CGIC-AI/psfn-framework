import type { SubstrateMessage } from '../types.js';

export type TurnIntent = 'dev' | 'memory' | 'ops' | 'social';

export interface ExtendedToolAutoloadPolicy {
  maxPreloadCount: number;
  classifyIntent: (
    message: Pick<SubstrateMessage, 'channelId' | 'channelType' | 'content'>,
    taskKind?: string,
  ) => TurnIntent;
  getCandidatesForIntent: (intent: TurnIntent) => readonly string[];
}

const DEV_PATTERN = /\b(git|repo|branch|commit|diff|patch|pr|pull request|code|test|build|lint|debug|bug|issue|ticket|beads|refactor|typescript|javascript|python|npm|pnpm|yarn)\b/i;
const MEMORY_PATTERN = /\b(memory|remember|recall|journal|scratchpad|profile|contact|trust|archive|history)\b/i;
const OPS_PATTERN = /\b(schedule|heartbeat|policy|runtime|settings|restart|rebuild|maintenance|incident|ops|operation)\b/i;
const OPS_TASK_KINDS = new Set(['heartbeat', 'reflection', 'planning', 'maintenance']);

export const DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX = 3;

export const DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES: Readonly<Record<TurnIntent, readonly string[]>> = {
  dev: [
    'repo_status',
    'repo_diff',
    'repo_apply_patch',
    'repo_commit',
    'repo_create_branch',
    'repo_open_pr',
    'issue_ready',
    'issue_show',
    'issue_create',
    'issue_update',
    'issue_close',
    'issue_sync',
  ],
  memory: [
    'session_list',
    'session_resume',
    'session_new',
    'prompt_layer_list',
    'prompt_layer_get',
    'identity_diff',
  ],
  ops: [
    'settings_get',
    'heartbeat_get_policy',
    'heartbeat_run_template',
    'schedule_task',
    'session_list',
    'issue_ready',
    'issue_show',
    'issue_sync',
  ],
  social: [],
};

export function classifyTurnIntent(
  message: Pick<SubstrateMessage, 'channelId' | 'channelType' | 'content'>,
  taskKind?: string,
): TurnIntent {
  if (message.channelId.startsWith('internal:')) {
    return 'ops';
  }

  const normalizedTaskKind = taskKind?.trim().toLowerCase();
  if (normalizedTaskKind && OPS_TASK_KINDS.has(normalizedTaskKind)) {
    return 'ops';
  }

  if (OPS_PATTERN.test(message.content)) {
    return 'ops';
  }
  if (MEMORY_PATTERN.test(message.content)) {
    return 'memory';
  }
  if (DEV_PATTERN.test(message.content) || message.content.includes('```')) {
    return 'dev';
  }

  if (message.channelType === 'terminal') {
    return 'dev';
  }

  return 'social';
}

export function createDefaultExtendedToolAutoloadPolicy(
  maxPreloadCount: number = DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX,
): ExtendedToolAutoloadPolicy {
  const boundedMax = Number.isFinite(maxPreloadCount)
    ? Math.max(0, Math.floor(maxPreloadCount))
    : DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX;

  return {
    maxPreloadCount: boundedMax,
    classifyIntent: classifyTurnIntent,
    getCandidatesForIntent: (intent) => DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES[intent],
  };
}
