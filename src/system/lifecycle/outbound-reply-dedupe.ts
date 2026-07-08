import { createHash } from 'node:crypto';

/**
 * Shared, in-process guard against the same reply text being delivered to the
 * same channel twice within a short window.
 *
 * Why this exists: outbound replies to a channel can originate from more than
 * one independent turn execution. The Discord inbound pump
 * (`src/app/agent/gateway-message-handlers.ts`) delivers the primary reply, and
 * a separate deferred-tool-handoff *continuation* turn
 * (`src/core/scheduler/heartbeat-post-turn-runtime.ts`) can run afterwards and
 * deliver its own model-generated reply to the same channel. Those two paths
 * share no dedupe state, so when the continuation regenerates text identical to
 * the already-delivered reply the operator sees the message twice, roughly one
 * turn apart. Inbound-message dedupe and tool-call dedupe do not cover this
 * because the two sends come from two distinct turns.
 *
 * This registry records every reply that is actually delivered and lets a
 * self-initiated (replay-prone) sender check, before sending, whether it would
 * duplicate a reply already delivered to the channel. Suppression is always
 * surfaced loudly by the caller — never silent.
 */

export const DEFAULT_OUTBOUND_REPLY_DEDUPE_WINDOW_MS = 5 * 60_000;

interface DeliveredReplyRecord {
  hash: string;
  deliveredAt: number;
  sourceTurnId: string | null;
  senderKind: string;
}

export interface NoteDeliveredReplyInput {
  channelId: string;
  content: string;
  sourceTurnId?: string | null;
  senderKind: string;
}

export interface EvaluateOutboundReplyInput {
  channelId: string;
  content: string;
}

export interface OutboundReplyDuplicateDecision {
  hash: string;
  priorDeliveredAt: number;
  ageMs: number;
  priorSourceTurnId: string | null;
  priorSenderKind: string;
}

export interface OutboundReplyGuardPort {
  /** Record a reply that was actually delivered to a channel. */
  noteDelivered(input: NoteDeliveredReplyInput): void;
  /**
   * Returns a suppression decision when the candidate reply exactly matches a
   * reply already delivered to the same channel within the window, else null.
   */
  evaluate(input: EvaluateOutboundReplyInput): OutboundReplyDuplicateDecision | null;
}

function normalizeReplyContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export class OutboundReplyDeduper implements OutboundReplyGuardPort {
  private readonly byChannel = new Map<string, DeliveredReplyRecord[]>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs && options.windowMs > 0
      ? options.windowMs
      : DEFAULT_OUTBOUND_REPLY_DEDUPE_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  private hash(content: string): string {
    return createHash('sha256').update(normalizeReplyContent(content)).digest('hex');
  }

  private prune(channelId: string, now: number): DeliveredReplyRecord[] {
    const records = this.byChannel.get(channelId);
    if (!records) return [];
    const minDeliveredAt = now - this.windowMs;
    const kept = records.filter((record) => record.deliveredAt >= minDeliveredAt);
    if (kept.length > 0) {
      this.byChannel.set(channelId, kept);
    } else {
      this.byChannel.delete(channelId);
    }
    return kept;
  }

  noteDelivered(input: NoteDeliveredReplyInput): void {
    if (normalizeReplyContent(input.content).length === 0) {
      return;
    }
    const now = this.now();
    const records = this.prune(input.channelId, now);
    records.push({
      hash: this.hash(input.content),
      deliveredAt: now,
      sourceTurnId: input.sourceTurnId ?? null,
      senderKind: input.senderKind,
    });
    this.byChannel.set(input.channelId, records);
  }

  evaluate(input: EvaluateOutboundReplyInput): OutboundReplyDuplicateDecision | null {
    if (normalizeReplyContent(input.content).length === 0) {
      return null;
    }
    const now = this.now();
    const records = this.prune(input.channelId, now);
    const candidateHash = this.hash(input.content);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.hash === candidateHash) {
        return {
          hash: candidateHash,
          priorDeliveredAt: record.deliveredAt,
          ageMs: now - record.deliveredAt,
          priorSourceTurnId: record.sourceTurnId,
          priorSenderKind: record.senderKind,
        };
      }
    }
    return null;
  }
}
