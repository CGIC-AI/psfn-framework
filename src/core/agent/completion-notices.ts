/**
 * Compact, ephemeral background-completion notices.
 *
 * Replaces the old behavior of persisting full CompletionHandoff JSON blobs
 * as session-store system messages (which polluted every channel's transcript
 * and displaced real conversation in the count-based history fetch).
 *
 * Contract:
 * - Notices are NEVER written to the session store. They live in memory only;
 *   the durable record of a completion is the `agent.completion_handoff`
 *   event-bus emission and its journal/telemetry consumers.
 * - A notice is at most two short lines, rendered once into the prompt's
 *   `background_completions` system block (well above the recent chat tail),
 *   then dropped. If the agent restarts before render, the notice is lost by
 *   design — the event journal still has the full record.
 * - Only companion-relevant completions produce notices (subagent/shard
 *   results, background continuations carrying a deliverable). Maintenance
 *   bookkeeping (near-turn memory, episode synthesis, follow-up activation,
 *   queue drops) must not create notices at all.
 */

import type { CompletionHandoffRecord } from '../../shared/contracts/completion-handoff.js';

const MAX_NOTICES_PER_CHANNEL = 8;
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICE_SUMMARY_CHARS = 160;
const RESULT_REF_BOUNDS = {
  count: 4,
  labelChars: 24,
  valueChars: 60,
  renderedChars: 90,
} as const;

export interface CompletionNoticeResultRef {
  kind: string;
  ref: string;
  label?: string;
}

export interface CompletionNotice {
  dedupeKey: string;
  label: string;
  status: CompletionHandoffRecord['status'];
  summary: string;
  resultRefs: CompletionNoticeResultRef[];
  createdAt: number;
}

export function renderCompletionNoticeLines(notice: CompletionNotice): string {
  const renderedRefs = renderResultRefs(notice.resultRefs);
  const suffix = renderedRefs ? ` [result refs: ${renderedRefs}]` : '';
  const summaryBudget = Math.max(1, MAX_NOTICE_SUMMARY_CHARS - suffix.length);
  return [
    `[background completion] ${notice.label} — ${notice.status}`,
    `${truncate(notice.summary, summaryBudget)}${suffix}`,
  ].join('\n');
}

export function buildCompletionNotice(handoff: CompletionHandoffRecord): CompletionNotice {
  const label = handoff.task.label?.trim() || handoff.task.id;
  const normalizedSummary = handoff.result.summary.replace(/\s+/g, ' ').trim();
  const summary = normalizedSummary.length > MAX_NOTICE_SUMMARY_CHARS
    ? `${normalizedSummary.slice(0, MAX_NOTICE_SUMMARY_CHARS - 3)}...`
    : normalizedSummary;
  const resultRefs = [...handoff.refs.artifacts, ...handoff.refs.outputs]
    .slice(0, RESULT_REF_BOUNDS.count)
    .map(ref => ({
      kind: truncate(ref.kind, RESULT_REF_BOUNDS.labelChars),
      ref: truncate(ref.ref, RESULT_REF_BOUNDS.valueChars),
      ...(ref.label
        ? { label: truncate(ref.label, RESULT_REF_BOUNDS.labelChars) }
        : {}),
    }));
  return {
    dedupeKey: handoff.dedupeKey,
    label,
    status: handoff.status,
    summary,
    resultRefs,
    createdAt: handoff.createdAt,
  };
}

function renderResultRefs(refs: readonly CompletionNoticeResultRef[]): string {
  let rendered = '';
  for (const ref of refs) {
    const label = (ref.label?.trim() || ref.kind).replace(/\s+/g, ' ');
    const value = ref.ref.replace(/\s+/g, ' ').trim();
    if (!label || !value) continue;
    const candidate = `${label}=${value}`;
    const next = rendered ? `${rendered}; ${candidate}` : candidate;
    if (next.length > RESULT_REF_BOUNDS.renderedChars) {
      if (!rendered) rendered = truncate(candidate, RESULT_REF_BOUNDS.renderedChars);
      break;
    }
    rendered = next;
  }
  return rendered;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

export class CompletionNoticeBuffer {
  private readonly noticesByChannel = new Map<string, CompletionNotice[]>();

  /**
   * Register a notice for a channel. Dedupes by dedupeKey and by task label
   * (a newer completion of the same task replaces the older notice instead of
   * stacking). Oldest notices are dropped beyond the per-channel cap.
   */
  register(channelId: string, notice: CompletionNotice): void {
    const key = channelId.trim();
    if (!key) return;
    const existing = this.noticesByChannel.get(key) ?? [];
    const filtered = existing.filter(
      candidate => candidate.dedupeKey !== notice.dedupeKey && candidate.label !== notice.label,
    );
    filtered.push(notice);
    while (filtered.length > MAX_NOTICES_PER_CHANNEL) {
      filtered.shift();
    }
    this.noticesByChannel.set(key, filtered);
  }

  /**
   * Remove and return all live notices for a channel. Expired notices are
   * discarded. Draining is what enforces render-once semantics.
   */
  drain(channelId: string, now = Date.now()): CompletionNotice[] {
    const key = channelId.trim();
    if (!key) return [];
    const notices = this.noticesByChannel.get(key);
    if (!notices || notices.length === 0) return [];
    this.noticesByChannel.delete(key);
    return notices.filter(notice => now - notice.createdAt <= NOTICE_TTL_MS);
  }

  /** Peek without draining (observability/tests). */
  peek(channelId: string): readonly CompletionNotice[] {
    return this.noticesByChannel.get(channelId.trim()) ?? [];
  }
}

export function renderBackgroundCompletionsBlock(notices: readonly CompletionNotice[]): string {
  if (notices.length === 0) return '';
  const body = notices.map(renderCompletionNoticeLines).join('\n');
  return [
    '<background_completions>',
    'Internal background work finished since your last turn. Companion-only context; mention it to the partner only if policy and the conversation call for it.',
    body,
    '</background_completions>',
  ].join('\n');
}
