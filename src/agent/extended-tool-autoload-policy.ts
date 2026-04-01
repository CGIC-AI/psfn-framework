import type { SubstrateMessage } from '../types.js';

export type TurnIntent = 'dev' | 'memory' | 'ops' | 'social';
export type ToolTurnClass = 'core' | 'overlay' | 'background';
export type ExtendedToolTurnClass = Exclude<ToolTurnClass, 'core'>;
export type OverlaySelectionSkipReason =
  | 'invalid_metadata'
  | 'duplicate_candidate'
  | 'not_overlay_eligible'
  | 'not_registered'
  | 'budget_exhausted';

export interface OverlaySelectionSkip {
  toolName: string;
  reason: OverlaySelectionSkipReason;
}

export interface OverlaySelectionResult {
  candidates: string[];
  selected: string[];
  skipped: OverlaySelectionSkip[];
  maxCount: number;
}

export interface ToolTurnClassificationOptions {
  coreToolNames?: readonly string[] | ReadonlySet<string>;
  backgroundOnlyToolNames?: readonly string[] | ReadonlySet<string>;
}

export interface ExtendedToolAutoloadPolicy {
  maxPreloadCount: number;
  classifyIntent: (
    message: Pick<SubstrateMessage, 'channelId' | 'channelType' | 'content'>,
    taskKind?: string,
  ) => TurnIntent;
  getCandidatesForIntent: (intent: TurnIntent) => readonly string[];
  classifyToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  selectOverlayCandidates: (
    intent: TurnIntent,
    registeredToolNames: readonly string[],
    maxCount?: number,
  ) => OverlaySelectionResult;
}

const DEV_PATTERN = /\b(git|repo|branch|commit|diff|patch|pr|pull request|code|test|build|lint|debug|bug|issue|ticket|beads|refactor|typescript|javascript|python|npm|pnpm|yarn)\b/i;
const MEMORY_PATTERN = /\b(memory|remember|recall|journal|scratchpad|profile|contact|trust|archive|history|vault|obsidian|note|daily note)\b/i;
const OPS_PATTERN = /\b(schedule|heartbeat|policy|runtime|settings|restart|rebuild|maintenance|incident|ops|operation)\b/i;
const OPS_TASK_KINDS = new Set(['heartbeat', 'reflection', 'planning', 'maintenance']);

export const DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX = 3;
export const DEFAULT_BACKGROUND_ONLY_EXTENDED_TOOLS: ReadonlySet<string> = new Set([
  'schedule_task',
  'heartbeat_run_template',
]);

export const DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES: Readonly<Record<TurnIntent, readonly string[]>> = {
  dev: [
    'repo_apply_patch',
    'repo_commit',
    'repo_create_branch',
    'repo_open_pr',
    'issue_create',
    'issue_update',
    'issue_close',
    'issue_sync',
  ],
  memory: [
    'vault_write',
    'vault_read',
    'vault_search',
    'vault_daily',
    'identity',
    'north_star',
  ],
  ops: [
    'heartbeat_update_policy',
    'heartbeat_run_template',
    'schedule_task',
    'issue_sync',
  ],
  social: [
    'media',
    'vault_write',
    'vault_daily',
  ],
};

function hasToolName(
  toolNames: readonly string[] | ReadonlySet<string> | undefined,
  targetToolName: string,
): boolean {
  if (!toolNames) return false;
  for (const rawToolName of toolNames) {
    if (rawToolName.trim() === targetToolName) {
      return true;
    }
  }
  return false;
}

export function classifyToolForTurn(
  toolName: string,
  options?: ToolTurnClassificationOptions,
): ToolTurnClass {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    return 'background';
  }

  if (hasToolName(options?.coreToolNames, normalizedToolName)) {
    return 'core';
  }

  const backgroundToolNames = options?.backgroundOnlyToolNames ?? DEFAULT_BACKGROUND_ONLY_EXTENDED_TOOLS;
  if (hasToolName(backgroundToolNames, normalizedToolName)) {
    return 'background';
  }

  return 'overlay';
}

export function classifyExtendedToolForTurn(toolName: string): ExtendedToolTurnClass {
  const turnClass = classifyToolForTurn(toolName);
  return turnClass === 'overlay' ? 'overlay' : 'background';
}

function toBoundedMax(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function selectBoundedOverlayCandidates(
  candidateNames: readonly string[],
  registeredToolNames: readonly string[],
  maxCount: number,
  options?: ToolTurnClassificationOptions,
): OverlaySelectionResult {
  const boundedMax = toBoundedMax(maxCount, DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX);
  const registered = new Set(registeredToolNames);
  const candidates: string[] = [];
  const selected: string[] = [];
  const skipped: OverlaySelectionSkip[] = [];
  const seen = new Set<string>();

  for (const rawName of candidateNames) {
    const normalized = rawName.trim();
    if (!normalized) {
      skipped.push({
        toolName: rawName,
        reason: 'invalid_metadata',
      });
      continue;
    }

    if (seen.has(normalized)) {
      skipped.push({
        toolName: normalized,
        reason: 'duplicate_candidate',
      });
      continue;
    }
    seen.add(normalized);
    candidates.push(normalized);

    if (classifyToolForTurn(normalized, options) !== 'overlay') {
      skipped.push({
        toolName: normalized,
        reason: 'not_overlay_eligible',
      });
      continue;
    }

    if (!registered.has(normalized)) {
      skipped.push({
        toolName: normalized,
        reason: 'not_registered',
      });
      continue;
    }

    if (selected.length >= boundedMax) {
      skipped.push({
        toolName: normalized,
        reason: 'budget_exhausted',
      });
      continue;
    }

    selected.push(normalized);
  }

  return {
    candidates,
    selected,
    skipped,
    maxCount: boundedMax,
  };
}

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
  const boundedMax = toBoundedMax(maxPreloadCount, DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX);

  return {
    maxPreloadCount: boundedMax,
    classifyIntent: classifyTurnIntent,
    getCandidatesForIntent: (intent) => DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES[intent],
    classifyToolForTurn: classifyExtendedToolForTurn,
    selectOverlayCandidates: (intent, registeredToolNames, maxCount = boundedMax) => selectBoundedOverlayCandidates(
      DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES[intent],
      registeredToolNames,
      maxCount,
    ),
  };
}
