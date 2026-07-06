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

export interface CompletionNotice {
  dedupeKey: string;
  label: string;
  status: CompletionHandoffRecord['status'];
  summary: string;
  createdAt: number;
}

export function renderCompletionNoticeLines(notice: CompletionNotice): string {
  return [
    `[background completion] ${notice.label} — ${notice.status}`,
    notice.summary,
  ].join('\n');
}

export function buildCompletionNotice(handoff: CompletionHandoffRecord): CompletionNotice {
  const label = handoff.task.label?.trim() || handoff.task.id;
  const normalizedSummary = handoff.result.summary.replace(/\s+/g, ' ').trim();
  const summary = normalizedSummary.length > MAX_NOTICE_SUMMARY_CHARS
    ? `${normalizedSummary.slice(0, MAX_NOTICE_SUMMARY_CHARS - 3)}...`
    : normalizedSummary;
  return {
    dedupeKey: handoff.dedupeKey,
    label,
    status: handoff.status,
    summary,
    createdAt: handoff.createdAt,
  };
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
