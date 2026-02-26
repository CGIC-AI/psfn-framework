import type { EventName } from '../../event-bus.js';
import type { TaskState } from '../../scheduler/types.js';
import type { ThinkEvidence } from '../types.js';
import type { SandboxBudgetRef } from './contracts.js';

export const BUDGET_EXCEEDED_MESSAGE = '[Budget exceeded: max sub-queries reached]';
export const TOOL_CALL_BUDGET_EXCEEDED_MESSAGE = '[Budget exceeded: max tool calls reached]';

export const REPL_EVENT_ALLOWLIST: ReadonlySet<EventName> = new Set([
  'schedule.tick',
  'schedule.task.run',
  'schedule.heartbeat',
]);

export const VALID_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'idle',
  'active',
  'paused',
  'complete',
]);

export function nextReplTaskId(): string {
  return `repl:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseRunAt(value: number | string | Date): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? null : ts;
  }
  return null;
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeErrorMessage(err: unknown): string {
  const segments: string[] = [];
  const push = (value: unknown) => {
    if (!value || typeof value !== 'string') return;
    if (!segments.includes(value)) segments.push(value);
  };

  if (err instanceof Error) {
    push(err.message);
    const errCode = (err as { code?: unknown }).code;
    if (typeof errCode === 'string' || typeof errCode === 'number') {
      push(`code=${String(errCode)}`);
    }

    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const causeMsg = (cause as { message?: unknown }).message;
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeMsg === 'string') {
        push(`cause=${causeMsg}`);
      }
      if (typeof causeCode === 'string' || typeof causeCode === 'number') {
        push(`cause_code=${String(causeCode)}`);
      }
    }
  } else if (typeof err === 'object' && err) {
    const msg = (err as { message?: unknown }).message;
    const code = (err as { code?: unknown }).code;
    if (typeof msg === 'string') push(msg);
    if (typeof code === 'string' || typeof code === 'number') {
      push(`code=${String(code)}`);
    }
  } else {
    push(String(err));
  }

  return segments.length > 0 ? segments.join(' | ') : String(err);
}

export function addEvidence(
  sink: (entry: ThinkEvidence) => void,
  entry: Omit<ThinkEvidence, 'timestamp'> & { timestamp?: number },
): void {
  sink({
    ...entry,
    ...(entry.query ? { query: entry.query.slice(0, 100) } : {}),
    snippet: entry.snippet.slice(0, 200),
    timestamp: entry.timestamp ?? Date.now(),
  });
}

export function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function consumeToolCallBudget(budgetRef?: SandboxBudgetRef): boolean {
  if (!budgetRef || budgetRef.maxToolCalls === undefined) {
    return true;
  }

  const max = Number.isFinite(budgetRef.maxToolCalls)
    ? Math.max(1, Math.floor(budgetRef.maxToolCalls))
    : 1;
  const used = Number.isFinite(budgetRef.toolCalls)
    ? Math.max(0, Math.floor(budgetRef.toolCalls ?? 0))
    : 0;

  if (used >= max) {
    budgetRef.toolCalls = used;
    return false;
  }

  budgetRef.toolCalls = used + 1;
  return true;
}

export function splitCsvTags(tags?: string): string[] | undefined {
  if (!tags) return undefined;
  const parsed = tags
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

export function normalizeRepoPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}
