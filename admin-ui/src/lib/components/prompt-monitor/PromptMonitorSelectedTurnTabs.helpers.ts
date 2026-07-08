import {
  formatPromptMonitorStageLabel,
  type PromptMonitorTurn,
  type PromptPlanBlockDiffEntry,
} from '$lib/events/prompt-monitor';
import type { AdminPromptPlanBlock } from '$lib/types';

export type SelectedTurnTab =
  | 'summary'
  | 'blocks'
  | 'prompt'
  | 'context'
  | 'tools'
  | 'exact'
  | 'provider'
  | 'cache'
  | 'diff'
  | 'timeline'
  | 'raw';

export const selectedTurnTabs = [
  { id: 'summary', label: 'Summary', description: 'Route, prompt, timing, and outcome triage' },
  { id: 'blocks', label: 'Blocks', description: 'Ordered PromptPlan blocks with producer, scope, volatility, and token estimates' },
  { id: 'prompt', label: 'Prompt Assembly', description: 'Templates, rendered blocks, assembled prompt, and model context' },
  { id: 'context', label: 'Context & Memory', description: 'Session inputs, memory retrievals, withholds, and metadata' },
  { id: 'tools', label: 'Tools', description: 'Shipped tool definitions (plan-backed) and adaptive activation state' },
  { id: 'exact', label: 'Exact Payload', description: 'Exact provider input, tools, response, memory capture, and tool activity' },
  { id: 'provider', label: 'Provider Wire', description: 'Serialized provider payload from the PromptPlan, routing, and response' },
  { id: 'cache', label: 'Cache', description: 'Volatility regions, cache boundaries, static-prefix hash timeline, and provider cache telemetry' },
  { id: 'diff', label: 'Turn Diff', description: 'Block-level plan diff between this turn and a baseline turn' },
  { id: 'timeline', label: 'Timeline', description: 'Stage order, elapsed time, and stage payloads' },
  { id: 'raw', label: 'Raw Events', description: 'Record, snapshot, stage telemetry, and live bus envelopes' },
] satisfies Array<{ id: SelectedTurnTab; label: string; description: string }>;

export function regionTokens(blocks: readonly AdminPromptPlanBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokensEst, 0);
}

export function volatilityTone(volatility: string): string {
  switch (volatility) {
    case 'static':
      return 'border-moss-300 bg-moss-50 text-moss-800';
    case 'session_stable':
      return 'border-gold-300 bg-gold-50 text-shadow-900';
    case 'turn':
      return 'border-wilt-300 bg-wilt-50 text-wilt-800';
    default:
      return 'border-bark-300 bg-bark-100 text-shadow-700';
  }
}

export function diffStatusTone(status: PromptPlanBlockDiffEntry['status']): string {
  switch (status) {
    case 'added':
      return 'border-moss-300 bg-moss-50 text-moss-800';
    case 'removed':
      return 'border-wilt-300 bg-wilt-50 text-wilt-800';
    case 'changed':
      return 'border-gold-300 bg-gold-50 text-shadow-900';
    default:
      return 'border-bark-300 bg-bark-100 text-shadow-700';
  }
}

export function formatBytesDelta(entry: PromptPlanBlockDiffEntry): string {
  if (entry.status === 'added') return `+${entry.bytesAfter ?? 0} bytes`;
  if (entry.status === 'removed') return `-${entry.bytesBefore ?? 0} bytes`;
  if (entry.bytesDelta == null) return '—';
  if (entry.bytesDelta === 0) return `±0 bytes (${entry.bytesAfter ?? 0} total, content changed)`;
  const sign = entry.bytesDelta > 0 ? '+' : '';
  return `${sign}${entry.bytesDelta} bytes (${entry.bytesBefore ?? 0} → ${entry.bytesAfter ?? 0})`;
}

export function toTimestamp(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatDuration(value: number | null): string {
  if (value == null) return '—';
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${(value / 60_000).toFixed(2)}m`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString();
}

export function formatTimestamp(value: number | null): string {
  if (value == null) return '—';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function truncateValue(value: string | null | undefined, limit: number = 18): string {
  if (!value) return '—';
  if (value.length <= limit) return value;
  // Honest display cap: mark shortened values with their original length so
  // the operator never mistakes a UI cap for real truncation (bead u9jo.2).
  return `${value.slice(0, limit)}… [${value.length} chars]`;
}

// Source of truth: AdminSessionTurnObservabilityStore buffer caps
// (src/operator/garden/services/session-turn-observability.ts). Surfaced so a
// trimmed buffer is never mistaken for missing telemetry (bead u9jo.2).
export const STAGE_BUFFER_LIMIT = 16;
export const RETRIEVAL_BUFFER_LIMIT = 8;

export interface ToolInvocationView {
  sequence: number;
  toolName: string;
  toolCallId?: string;
  argumentsJson: string | null;
  resultStatus: 'ok' | 'error' | 'pending';
  resultText?: string;
  rationale?: string;
  provenanceRefs?: string[];
}

export function toolInvocations(currentTurn: PromptMonitorTurn): ToolInvocationView[] {
  const calls = currentTurn.record?.toolCalls ?? [];
  return calls.map((call, index) => ({
    sequence: index + 1,
    toolName: call.toolName,
    ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
    argumentsJson: call.arguments ? JSON.stringify(call.arguments, null, 2) : null,
    resultStatus: call.isError === true
      ? 'error'
      : (call.resultText !== undefined || call.details !== undefined || call.isError === false)
        ? 'ok'
        : 'pending',
    ...(call.resultText ? { resultText: call.resultText } : {}),
    ...(call.rationale ? { rationale: call.rationale } : {}),
    ...(call.provenanceRefs && call.provenanceRefs.length > 0
      ? { provenanceRefs: call.provenanceRefs }
      : {}),
  }));
}

export function metricTone(value: number | null, warningThreshold: number): string {
  if (value == null) return 'text-shadow-700';
  return value >= warningThreshold ? 'text-wilt-600' : 'text-moss-700';
}

export function joinLines(values: readonly string[] | null | undefined): string | null {
  if (!values || values.length === 0) return null;
  return values.join('\n\n');
}

export function formatJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value, null, 2);
}

export function humanizeToken(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatCapability(value: boolean | null | undefined): string {
  if (value == null) return '—';
  return value ? 'Yes' : 'No';
}

export function formatStageName(value: string | null | undefined): string {
  return value ? formatPromptMonitorStageLabel(value) : '—';
}

export function memoryCount(currentTurn: PromptMonitorTurn): number {
  const memory = currentTurn.snapshot?.memory;
  if (!memory) return 0;
  return memory.contactEmotionalMemories.length
    + memory.semanticCandidates.length
    + memory.lexicalCandidates.length
    + memory.proactiveCandidates.length;
}

export function activeToolCount(currentTurn: PromptMonitorTurn): number {
  return currentTurn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.total
    ?? currentTurn.snapshot?.toolContext?.activeTools?.length
    ?? 0;
}

export function skippedToolCount(currentTurn: PromptMonitorTurn): number {
  return currentTurn.snapshot?.toolContext?.adaptiveSnapshot?.skipped?.length ?? 0;
}

export function stageFieldCount(stage: PromptMonitorTurn['stages'][number]): number {
  return Object.entries(stage.data).length;
}

export function sessionMetadataJson(currentTurn: PromptMonitorTurn): string | null {
  const sessionContext = currentTurn.snapshot?.sessionContext;
  if (!sessionContext) return null;
  return formatJson({
    channelId: sessionContext.channelId,
    versionPointer: sessionContext.versionPointer,
    recentEntryCount: sessionContext.recentEntries.length,
    continuityEntryCount: sessionContext.continuityEntries.length,
    compactionSummaryCount: sessionContext.compactionSummaryTexts.length,
    focusKnowledgeCount: sessionContext.focusKnowledgeTexts.length,
  });
}

export function memoryMetadataJson(currentTurn: PromptMonitorTurn): string | null {
  const memory = currentTurn.snapshot?.memory;
  if (!memory) return null;
  return formatJson({
    channelId: memory.channelId,
    versionPointer: memory.versionPointer,
    profile: memory.profile,
    emotionalSnapshot: memory.emotionalSnapshot,
    withheldSummary: memory.withheldSummary,
  });
}
