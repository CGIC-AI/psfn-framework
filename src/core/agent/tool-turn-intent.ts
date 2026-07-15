import type { SubstrateMessage } from '../../shared/contracts/runtime.js';

export type TurnIntent = 'dev' | 'memory' | 'ops' | 'reflection' | 'social';

const DEV_PATTERN = /\b(git|repo|branch|commit|diff|patch|pr|pull request|code|test|build|lint|debug|bug|issue|ticket|beads|refactor|typescript|javascript|python|npm|pnpm|yarn)\b/i;
const MEMORY_PATTERN = /\b(memory|remember|recall|journal|scratchpad|profile|contact|trust|archive|history|vault|obsidian|note|daily note)\b/i;
const ROUTINE_ORIENTATION_PATTERN = /\b(orient|orientation|reorient|values_list|active concerns?|open threads?|list concerns?|create concerns?|resolve concerns?|persona block|human block|goals block)\b/i;
const OPS_PATTERN = /\b(schedule|heartbeat|policy|runtime|settings|restart|rebuild|maintenance|incident|ops|operation)\b/i;
const OPS_TASK_KINDS = new Set(['heartbeat', 'planning', 'maintenance']);

/** Classifies turn intent for prompt/policy decisions. It never changes tools. */
export function classifyTurnIntent(
  message: Pick<SubstrateMessage, 'channelId' | 'channelType' | 'content'>,
  taskKind?: string,
): TurnIntent {
  if (message.channelId.startsWith('internal:reflection:')) return 'reflection';

  const normalizedTaskKind = taskKind?.trim().toLowerCase();
  if (normalizedTaskKind === 'reflection') return 'reflection';
  if (message.channelId.startsWith('internal:')) return 'ops';
  if (normalizedTaskKind && OPS_TASK_KINDS.has(normalizedTaskKind)) return 'ops';
  if (OPS_PATTERN.test(message.content)) return 'ops';
  if (ROUTINE_ORIENTATION_PATTERN.test(message.content)) return 'memory';
  if (MEMORY_PATTERN.test(message.content)) return 'memory';
  if (DEV_PATTERN.test(message.content) || message.content.includes('```')) return 'dev';
  if (message.channelType === 'terminal') return 'dev';
  return 'social';
}
