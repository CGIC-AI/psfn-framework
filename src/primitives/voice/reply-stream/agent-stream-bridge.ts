// ── Agent → VoiceReplyStream bridge (psfn-framework-mmo9.8.3) ──
//
// The reusable core that turns a LIVE agent turn into speakable committed
// segments for the voice surfaces (satellite WS transport + companion app WS).
//
// CORE PRINCIPLE (operator, full-capability): the companion talks AND acts. The
// agent's live output is TWO separate event channels:
//   - text            → `agent.stream.delta`   (this bridge CONSUMES it)
//   - tool-call JSON   → `agent.toolcall.*`     (this bridge NEVER subscribes)
// Blocking the tool-call JSON from TTS is therefore structural: it is simply
// never fed in. Tools still execute on the normal agent loop while the text is
// spoken — home automation, selfie, work-delegation, search all keep working on
// voice. This module strips NO tools and gates NO capability.
//
// Text deltas flow into the mmo9.8.1 VoiceReplyStream (segmenter + per-segment
// content gates), and committed segments are surfaced as an async iterable that
// a TTS sink drinks from as each segment finalizes. The Law-18 whole-reply
// reconciliation tripwire is RELAXED here (reconcileFinalContent: false): voice
// speaks the live stream, not the turn's authoritative `AgentResponse.content`.
// The per-segment content gates (image-claim, datetime-contradiction) and the
// defensive in-order-prefix invariant are UNCHANGED and still fail closed.

import { createVoiceReplyStream } from './reply-stream.js';
import type {
  CommittedSegment,
  ContentGateConfig,
  ReplyStreamAbortReason,
  SegmenterConfig,
} from './types.js';

/** A single `agent.stream.delta` payload (text channel only). */
export interface AgentReplyDeltaEvent {
  readonly channelId: string;
  readonly text: string;
  readonly turnId?: string;
}

/**
 * Minimal structural port over the runtime EventBus. Intentionally exposes ONLY
 * the text delta channel — there is no toolcall subscription surface here, so
 * the bridge cannot accidentally feed tool-call JSON to TTS.
 */
export interface AgentReplyDeltaSource {
  on(
    event: 'agent.stream.delta',
    handler: (data: AgentReplyDeltaEvent) => void,
  ): () => void;
}

export interface AgentReplyStreamBridgeOptions {
  readonly deltaSource: AgentReplyDeltaSource;
  /** Only deltas for this channel are consumed (proven filter, chat-completions parity). */
  readonly channelId: string;
  readonly turnId: string;
  readonly cancellationId: string;
  readonly gate: ContentGateConfig;
  readonly segmenter: SegmenterConfig;
  /** Telemetry-only raw deltas — NEVER speakable (Law 18). */
  readonly onProvisionalDelta?: (delta: string) => void;
}

export interface AgentReplyStreamBridge {
  /**
   * Committed segments to speak, in order, as they finalize. Iteration ends
   * when the turn completes (`finish`), is withheld, aborts on a content gate,
   * or is cancelled (barge-in).
   */
  readonly segments: AsyncIterable<CommittedSegment>;
  /**
   * Signal the driving turn produced a sendable reply: flush the segmenter tail
   * and close the segment stream. `finalContent` is advisory (telemetry) — it is
   * NOT reconciled against the spoken segments on the voice path.
   */
  finish(finalContent: string): void;
  /**
   * The turn resolved to a genuine SYSTEM withhold (no_reply / response_control
   * chose silence, broadcast approval hold, safety refusal-swap, empty). Stop
   * WITHOUT flushing the tail — already-committed segments may already be
   * audible (a rare mid-stream edge), but no further text is spoken.
   */
  withhold(reason?: ReplyStreamAbortReason): void;
  /** Barge-in / hard stop: abort immediately and close the stream. */
  cancel(reason?: ReplyStreamAbortReason): void;
  /** True once the stream has terminated (finish/withhold/cancel/gate-abort). */
  readonly closed: boolean;
}

/**
 * Unbounded FIFO async queue. Committed segments are pushed as the model emits
 * them; a consumer awaits them one at a time. `close()` ends iteration cleanly.
 */
class SegmentQueue implements AsyncIterable<CommittedSegment> {
  private readonly values: CommittedSegment[] = [];
  private readonly waiters: Array<(result: IteratorResult<CommittedSegment>) => void> = [];
  private closed = false;

  push(value: CommittedSegment): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CommittedSegment> {
    return {
      next: (): Promise<IteratorResult<CommittedSegment>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ done: false, value: this.values.shift() as CommittedSegment });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as never });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<CommittedSegment>> => {
        // A consumer breaking out (barge-in) closes the queue so the producer
        // stops buffering; upstream cancellation is the caller's responsibility.
        this.close();
        return Promise.resolve({ done: true, value: undefined as never });
      },
    };
  }
}

export function createAgentReplyStreamBridge(
  options: AgentReplyStreamBridgeOptions,
): AgentReplyStreamBridge {
  const queue = new SegmentQueue();
  const stream = createVoiceReplyStream({
    segmenter: options.segmenter,
    gate: options.gate,
    reconcileFinalContent: false,
    ...(options.onProvisionalDelta ? { onProvisionalDelta: options.onProvisionalDelta } : {}),
  });
  stream.begin(options.turnId, options.cancellationId);

  let terminated = false;
  let pushedCount = 0;
  let unsubscribe: (() => void) | null = null;

  function teardown(): void {
    if (unsubscribe) {
      const u = unsubscribe;
      unsubscribe = null;
      u();
    }
  }

  function drainNewlyCommitted(all: readonly CommittedSegment[]): void {
    // Segments arrive in monotonic order; only those past what we've already
    // queued are new (finalize returns the FULL committed list, push returns
    // only its own delta — both are handled uniformly by the pushedCount cursor).
    for (let i = pushedCount; i < all.length; i++) {
      queue.push(all[i] as CommittedSegment);
    }
    if (all.length > pushedCount) {
      pushedCount = all.length;
    }
  }

  unsubscribe = options.deltaSource.on('agent.stream.delta', (data) => {
    if (terminated) return;
    if (data.channelId !== options.channelId) return;
    // If the event is turn-stamped, tighten to our turn; otherwise channel is
    // sufficient (sequential turns, subscription scoped to this turn only).
    if (data.turnId !== undefined && data.turnId !== options.turnId) return;
    if (data.text.length === 0) return;

    const result = stream.pushDelta(data.text);
    drainNewlyCommitted(stream.committedSegments);
    if (result.aborted) {
      // Forward-abort (content gate tripped): the contradicting segment is
      // never committed/spoken; stop the stream here.
      terminated = true;
      teardown();
      queue.close();
    }
  });

  return {
    segments: queue,
    finish(finalContent: string): void {
      if (terminated) return;
      teardown();
      if (stream.state === 'streaming') {
        stream.finalize(finalContent);
        drainNewlyCommitted(stream.committedSegments);
      }
      terminated = true;
      queue.close();
    },
    withhold(reason: ReplyStreamAbortReason = 'external'): void {
      if (terminated) return;
      teardown();
      if (stream.state === 'streaming') {
        stream.abort(reason);
      }
      terminated = true;
      queue.close();
    },
    cancel(reason: ReplyStreamAbortReason = 'cancelled'): void {
      if (terminated) return;
      teardown();
      if (stream.state === 'streaming') {
        stream.abort(reason);
      }
      terminated = true;
      queue.close();
    },
    get closed(): boolean {
      return terminated;
    },
  };
}
