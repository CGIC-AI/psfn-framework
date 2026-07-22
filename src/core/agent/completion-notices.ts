/**
 * Compact, ephemeral child-completion notices.
 *
 * Replaces the old behavior of persisting full CompletionHandoff JSON blobs
 * as session-store system messages (which polluted every channel's transcript
 * and displaced real conversation in the count-based history fetch).
 *
 * Contract:
 * - Notices are NEVER written to the session store. The child transcript or
 *   returned artifact remains the durable result; this queue is only the
 *   bounded signal that tells the parent companion where to look.
 * - A notice is at most two short lines, rendered once into the prompt's
 *   `background_completions` system block (well above the recent chat tail),
 *   then dropped. If the agent restarts before render, the notice is lost by
 *   design; child results remain addressable through their task/result refs.
 * - Only terminal automata/shard results produce notices. Maintenance
 *   bookkeeping and lifecycle progress must not enter companion context.
 */

import type { CompletionHandoffRecord } from '../../shared/contracts/completion-handoff.js';

const MAX_NOTICES_PER_CHANNEL = 8;
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICE_SUMMARY_CHARS = 160;
const MAX_NOTICE_LABEL_CHARS = 48;
const MAX_NOTICE_RESULT_REFS = 4;
const MAX_NOTICE_RESULT_REF_LABEL_CHARS = 24;
const MAX_NOTICE_RENDERED_REFS_CHARS = 110;

export interface CompletionNoticeResultRef {
  kind: string;
  ref: string;
  label?: string;
}

export interface CompletionNotice {
  dedupeKey: string;
  handoffId: string;
  source: CompletionHandoffRecord['source'];
  taskId: string;
  label: string;
  status: CompletionHandoffRecord['status'];
  summary: string;
  resultRefs: CompletionNoticeResultRef[];
  createdAt: number;
}

export type CompletionNoticeDeliveryDisposition = 'active_nudge' | 'buffered';

export interface CompletionNoticeDeliveryInput {
  sourceChannelId: string;
  logicalSessionId: string;
  notice: CompletionNotice;
}

export interface CompletionNoticeDeliveryPort {
  deliver(input: CompletionNoticeDeliveryInput): Promise<CompletionNoticeDeliveryDisposition>;
}

export function renderCompletionNoticeLines(notice: CompletionNotice): string {
  const renderedRefs = renderResultRefs(notice.resultRefs);
  const suffix = renderedRefs ? ` [result refs: ${renderedRefs}]` : '';
  const summaryBudget = Math.max(1, MAX_NOTICE_SUMMARY_CHARS - suffix.length);
  const sourceLabel = notice.source === 'subagent' ? 'automata' : notice.source;
  const heading = `[${sourceLabel} completion] ${notice.label} — ${notice.status} [task=${notice.taskId}]`;
  return [
    truncate(heading, MAX_NOTICE_SUMMARY_CHARS),
    `${truncate(notice.summary, summaryBudget)}${suffix}`,
  ].join('\n');
}

export function buildCompletionNotice(handoff: CompletionHandoffRecord): CompletionNotice {
  const label = truncate(handoff.task.label?.trim() || handoff.task.id, MAX_NOTICE_LABEL_CHARS);
  const normalizedSummary = handoff.result.summary.replace(/\s+/g, ' ').trim();
  const summary = normalizedSummary.length > MAX_NOTICE_SUMMARY_CHARS
    ? `${normalizedSummary.slice(0, MAX_NOTICE_SUMMARY_CHARS - 3)}...`
    : normalizedSummary;
  const resultRefs = [...handoff.refs.artifacts, ...handoff.refs.outputs]
    .slice(0, MAX_NOTICE_RESULT_REFS)
    .map(ref => ({
      kind: ref.kind,
      ref: ref.ref,
      ...(ref.label
        ? { label: ref.label }
        : {}),
    }));
  return {
    dedupeKey: handoff.dedupeKey,
    handoffId: handoff.handoffId,
    source: handoff.source,
    taskId: handoff.task.id,
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
    const label = renderResultRefLabel(ref).slice(0, MAX_NOTICE_RESULT_REF_LABEL_CHARS);
    const value = renderResultRefValue(ref).replace(/\s+/g, ' ').trim();
    if (!label || !value) continue;
    const candidate = `${label}=${value}`;
    const next = rendered ? `${rendered}; ${candidate}` : candidate;
    if (next.length > MAX_NOTICE_RENDERED_REFS_CHARS) {
      if (!rendered) rendered = truncate(candidate, MAX_NOTICE_RENDERED_REFS_CHARS);
      break;
    }
    rendered = next;
  }
  return rendered;
}

function renderResultRefLabel(ref: CompletionNoticeResultRef): string {
  const label = (ref.label?.trim() || ref.kind).replace(/\s+/g, ' ');
  return label.replace(/subagent/gi, 'automata');
}

function renderResultRefValue(ref: CompletionNoticeResultRef): string {
  const value = ref.ref.trim();
  return value.startsWith('subagent:') ? value.slice('subagent:'.length) : value;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

export class CompletionNoticeBuffer {
  private readonly noticesByChannel = new Map<string, CompletionNotice[]>();

  /**
   * Register a notice for a channel. Dedupes by dedupeKey and child task id
   * (a newer terminal state for the same task replaces the older notice instead of
   * stacking). Oldest notices are dropped beyond the per-channel cap.
   */
  register(channelId: string, notice: CompletionNotice): void {
    const key = channelId.trim();
    if (!key) return;
    const existing = this.noticesByChannel.get(key) ?? [];
    const filtered = existing.filter(
      candidate => candidate.dedupeKey !== notice.dedupeKey && candidate.taskId !== notice.taskId,
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
    'Delegated work reported back to you. This is private orchestration context, not partner speech. Review the result and decide your own next action.',
    body,
    '</background_completions>',
  ].join('\n');
}
