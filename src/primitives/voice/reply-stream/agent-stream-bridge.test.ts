import { describe, expect, it } from 'vitest';
import {
  createAgentReplyStreamBridge,
  type AgentReplyDeltaEvent,
  type AgentReplyDeltaSource,
} from './agent-stream-bridge.js';
import type { CommittedSegment, ContentGateConfig } from './types.js';

const GATE: ContentGateConfig = { attachmentCount: 0, datetimePromptContext: null };
const CHANNEL = 'api-voice:principal:conn-1';
const TURN = 'turn-1';

type DeltaHandler = (data: AgentReplyDeltaEvent) => void;

/**
 * A fake event source that exposes the text delta channel to the bridge AND a
 * separate toolcall channel the bridge must NEVER consume. Emitting on the
 * toolcall channel does nothing to the bridge, which is the whole point.
 */
class FakeAgentEvents implements AgentReplyDeltaSource {
  private readonly deltaHandlers = new Set<DeltaHandler>();

  on(_event: 'agent.stream.delta', handler: DeltaHandler): () => void {
    this.deltaHandlers.add(handler);
    return () => this.deltaHandlers.delete(handler);
  }

  emitText(text: string, opts?: { channelId?: string; turnId?: string }): void {
    const data: AgentReplyDeltaEvent = {
      channelId: opts?.channelId ?? CHANNEL,
      text,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    };
    for (const handler of [...this.deltaHandlers]) handler(data);
  }

  /** There is no bridge subscription for this — modeled as a no-op sink. */
  emitToolCallJson(_json: string): void {
    // Intentionally not routed anywhere the bridge can see.
  }

  get subscriberCount(): number {
    return this.deltaHandlers.size;
  }
}

async function drainAll(bridge: { segments: AsyncIterable<CommittedSegment> }): Promise<string[]> {
  const out: string[] = [];
  for await (const segment of bridge.segments) out.push(segment.text);
  return out;
}

describe('createAgentReplyStreamBridge', () => {
  it('speaks the text stream and never the tool-call JSON while a tool runs', async () => {
    const events = new FakeAgentEvents();
    const toolSideEffect: string[] = [];
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      gate: GATE,
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    // Preamble text (spoken), then a tool executes (side effect), then a
    // tool-call JSON is emitted on the toolcall channel (never spoken), then
    // the continuation text (spoken). This is a person talking while acting.
    events.emitText('Turning on the lights. ');
    toolSideEffect.push('home_automation:lights_on'); // the tool actually ran
    events.emitToolCallJson('{"name":"home_automation","arguments":{"device":"lights","state":"on"}}');
    events.emitText('All done for you. ');
    bridge.finish('Turning on the lights. All done for you.');

    const spoken = await drainAll(bridge);

    expect(spoken.join('')).toBe('Turning on the lights. All done for you. ');
    // The tool ran...
    expect(toolSideEffect).toEqual(['home_automation:lights_on']);
    // ...and NO spoken segment contains tool-call JSON.
    for (const text of spoken) {
      expect(text).not.toContain('{');
      expect(text).not.toContain('home_automation');
      expect(text).not.toContain('arguments');
    }
    expect(bridge.closed).toBe(true);
    expect(events.subscriberCount).toBe(0);
  });

  it('ignores deltas for other channels/turns', async () => {
    const events = new FakeAgentEvents();
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      gate: GATE,
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    events.emitText('Other channel noise. ', { channelId: 'someone-else' });
    events.emitText('Stale turn text. ', { turnId: 'turn-OLD' });
    events.emitText('This is for me. ', { turnId: TURN });
    bridge.finish('This is for me.');

    const spoken = await drainAll(bridge);
    expect(spoken.join('')).toBe('This is for me. ');
  });

  it('withhold stops without flushing the tail (genuine no_reply edge)', async () => {
    const events = new FakeAgentEvents();
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      gate: GATE,
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    events.emitText('First sentence done. ');
    // A partial trailing clause with no confirmed boundary — would be flushed
    // by finish(), but withhold must NOT speak it.
    events.emitText('and then something els');
    bridge.withhold();

    const spoken = await drainAll(bridge);
    expect(spoken).toEqual(['First sentence done. ']);
    expect(spoken.join('')).not.toContain('something els');
  });

  it('barge-in cancel ends the stream immediately and unsubscribes', async () => {
    const events = new FakeAgentEvents();
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      gate: GATE,
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    events.emitText('Speaking now. ');
    const iterator = bridge.segments[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.text).toBe('Speaking now. ');

    bridge.cancel('cancelled');
    expect(bridge.closed).toBe(true);
    expect(events.subscriberCount).toBe(0);

    // Post-cancel deltas are dropped; the stream is done.
    events.emitText('This should never be spoken. ');
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });

  it('does NOT reconcile the live stream against the authoritative final content', async () => {
    const events = new FakeAgentEvents();
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      gate: GATE,
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    events.emitText('The streamed words. ');
    // finalContent deliberately diverges (a late system rewrite). The
    // final-only path would THROW the Law-18 tripwire; the voice path must not.
    expect(() => bridge.finish('A completely different rewritten reply.')).not.toThrow();

    const spoken = await drainAll(bridge);
    expect(spoken.join('')).toBe('The streamed words. ');
  });

  it('forward-aborts on a content-gate trip (image-claim) and never speaks it', async () => {
    const events = new FakeAgentEvents();
    const bridge = createAgentReplyStreamBridge({
      deltaSource: events,
      channelId: CHANNEL,
      turnId: TURN,
      cancellationId: TURN,
      // attachmentCount 0 → a claim of an attached image trips the gate.
      gate: { attachmentCount: 0, datetimePromptContext: null },
      segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    });

    events.emitText('I attached an image for you. ');
    // Gate should have aborted; the stream is closed and nothing more speaks.
    expect(bridge.closed).toBe(true);
    const spoken = await drainAll(bridge);
    expect(spoken).toEqual([]);
  });
});
