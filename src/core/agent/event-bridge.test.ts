import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '../../boundary/pi-agent/index.js';
import { EventBus } from '../../shared/event-bus.js';
import { createEventBridge } from './event-bridge.js';

// Capture the subscriber callback by intercepting Agent.prototype.subscribe
let lastSubscriber: ((event: any) => void) | null = null;
vi.spyOn(Agent.prototype, 'subscribe').mockImplementation(function (fn: any) {
  lastSubscriber = fn;
  return () => { lastSubscriber = null; };
});

function emitAgentEvent(event: any) {
  lastSubscriber?.(event);
}

describe('createEventBridge', () => {
  let agent: Agent;
  let eventBus: EventBus;

  beforeEach(() => {
    lastSubscriber = null;
    agent = new Agent({ streamFn: vi.fn() as any, convertToLlm: (m) => m as any });
    eventBus = new EventBus();
  });

  it('subscribes to agent events on creation', () => {
    createEventBridge(agent, eventBus);
    expect(lastSubscriber).toBeTruthy();
  });

  it('does not emit events when no channel is set', async () => {
    createEventBridge(agent, eventBus);
    const handler = vi.fn();
    eventBus.on('agent.stream.delta', handler);

    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });

    // Give async emit time to fire (it won't since channel is null)
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits agent.stream.delta for text_delta events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('preserves the complete opening text from text_start events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('satellite:voice-only:bedroom');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: 'Hello' }] },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('preserves a one-chunk reply emitted only as text_start', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('satellite:voice-only:bedroom');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: 'Goodnight.' }] },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual(['Goodnight.']);
  });

  it('strips a mimicked history stamp from the start of a streamed text block', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: '[Mon 0' }] },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '7-13-26 14:32] good' },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' morning' },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: '[Mon 07-13-26 14:32] good morning',
        partial: { content: [{ type: 'text', text: '[Mon 07-13-26 14:32] good morning' }] },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas.join('')).toBe('good morning');
  });

  it('flushes a withheld partial stamp lookalike on text_end', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: 'see you soon\n[Mon 07-1' }] },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: 'see you soon\n[Mon 07-1',
        partial: { content: [{ type: 'text', text: 'see you soon\n[Mon 07-1' }] },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas.join('')).toBe('see you soon\n[Mon 07-1');
  });

  it('leaves a stamp quoted mid-sentence untouched in streamed text', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: 'you said that at [Mon ' }] },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '07-13-26 14:32] earlier' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas.join('')).toBe('you said that at [Mon 07-13-26 14:32] earlier');
  });

  it('does not flush an aborted block\'s withheld text into the next block', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    // Block aborted mid-candidate: no text_end arrives.
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { content: [{ type: 'text', text: '[Mon 07-1' }] },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 1,
        partial: { content: [{ type: 'text', text: '' }, { type: 'text', text: 'fresh block' }] },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas.join('')).toBe('fresh block');
  });

  it('emits agent.toolcall.start/delta/end for toolcall message events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const starts: any[] = [];
    const deltas: any[] = [];
    const ends: any[] = [];
    eventBus.on('agent.toolcall.start', (data) => { starts.push(data); });
    eventBus.on('agent.toolcall.delta', (data) => { deltas.push(data); });
    eventBus.on('agent.toolcall.end', (data) => { ends.push(data); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        partial: {
          content: [
            { type: 'text', text: 'ignored' },
            { type: 'toolCall', id: 'call-77', name: 'heartbeat_run_template', arguments: {} },
          ],
        },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"templateId":"daily-review"}',
        partial: {
          content: [
            { type: 'text', text: 'ignored' },
            { type: 'toolCall', id: 'call-77', name: 'heartbeat_run_template', arguments: {} },
          ],
        },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        partial: {
          content: [
            { type: 'text', text: 'ignored' },
            {
              type: 'toolCall',
              id: 'call-77',
              name: 'heartbeat_run_template',
              arguments: { templateId: 'daily-review' },
            },
          ],
        },
        toolCall: {
          type: 'toolCall',
          id: 'call-77',
          name: 'heartbeat_run_template',
          arguments: { templateId: 'daily-review' },
        },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      channelId: 'test-channel',
      contentIndex: 1,
      toolCallId: 'call-77',
      toolName: 'heartbeat_run_template',
      callType: 'tool',
      purpose: 'tool_call_stream',
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      channelId: 'test-channel',
      contentIndex: 1,
      delta: '{"templateId":"daily-review"}',
      toolCallId: 'call-77',
      toolName: 'heartbeat_run_template',
      callType: 'tool',
      purpose: 'tool_call_stream',
    });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      channelId: 'test-channel',
      contentIndex: 1,
      toolCallId: 'call-77',
      toolName: 'heartbeat_run_template',
      arguments: { templateId: 'daily-review' },
      callType: 'tool',
      purpose: 'tool_call_stream',
    });
  });

  it('emits agent.tool.start for tool_execution_start events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const events: any[] = [];
    eventBus.on('agent.tool.start', (data) => { events.push(data); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'analysis_workbench',
      args: { task: 'reason about cats' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: 'test-channel',
      toolCallId: 'call-1',
      toolName: 'analysis_workbench',
      callType: 'tool',
      purpose: 'tool_execution',
    });
  });

  it('emits agent.tool.end for tool_execution_end events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const events: any[] = [];
    eventBus.on('agent.tool.end', (data) => { events.push(data); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'analysis_workbench',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    });

    await new Promise(r => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: 'test-channel',
      toolCallId: 'call-1',
      toolName: 'analysis_workbench',
      isError: false,
      callType: 'tool',
      purpose: 'tool_execution',
    });
  });

  it('marks soft-error tool results as failures and forwards the error text', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const events: any[] = [];
    eventBus.on('agent.tool.end', (data) => { events.push(data); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-soft-error',
      toolName: 'notify',
      result: {
        content: [{ type: 'text', text: 'notify: failure (ntfy request failed: 503).' }],
        details: { isError: true },
      },
      isError: false,
    });

    await new Promise(r => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: 'test-channel',
      toolCallId: 'call-soft-error',
      toolName: 'notify',
      isError: true,
      errorMessage: 'notify: failure (ntfy request failed: 503).',
    });
  });

  it('propagates turn/request correlation across stream and tool events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const streamEvents: any[] = [];
    const toolEvents: any[] = [];
    eventBus.on('agent.stream.delta', (data) => { streamEvents.push(data); });
    eventBus.on('agent.tool.start', (data) => { toolEvents.push(data); });

    bridge.setChannel('test-channel', {
      turnId: 'turn-42',
      requestId: 'req-42',
      callType: 'scheduled',
    });

    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'tick' },
    });
    emitAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-42',
      toolName: 'heartbeat_run_template',
      args: {},
    });

    await new Promise(r => setTimeout(r, 10));

    expect(streamEvents[0]).toMatchObject({
      channelId: 'test-channel',
      turnId: 'turn-42',
      requestId: 'req-42',
      callType: 'scheduled',
      purpose: 'stream_text_delta',
    });
    expect(toolEvents[0]).toMatchObject({
      channelId: 'test-channel',
      turnId: 'turn-42',
      requestId: 'req-42',
      callType: 'tool',
      toolName: 'heartbeat_run_template',
      purpose: 'tool_execution',
    });
  });

  it('tags shard tool events with shardId derived from channelId', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const starts: any[] = [];
    const ends: any[] = [];
    eventBus.on('agent.tool.start', (data) => { starts.push(data); });
    eventBus.on('agent.tool.end', (data) => { ends.push(data); });

    bridge.setChannel('shard:shard-abc');
    emitAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-5',
      toolName: 'memory_write',
      args: {},
    });
    emitAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-5',
      toolName: 'memory_write',
      result: {},
      isError: false,
    });

    await new Promise(r => setTimeout(r, 10));
    expect(starts[0]?.shardId).toBe('shard-abc');
    expect(ends[0]?.shardId).toBe('shard-abc');
  });

  it('tags shard toolcall events with shardId derived from channelId', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const starts: any[] = [];
    const deltas: any[] = [];
    const ends: any[] = [];
    eventBus.on('agent.toolcall.start', (data) => { starts.push(data); });
    eventBus.on('agent.toolcall.delta', (data) => { deltas.push(data); });
    eventBus.on('agent.toolcall.end', (data) => { ends.push(data); });

    bridge.setChannel('shard:shard-xyz');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: {
          content: [
            { type: 'toolCall', id: 'call-99', name: 'web_search', arguments: {} },
          ],
        },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"query":"action inference"}',
        partial: {
          content: [
            { type: 'toolCall', id: 'call-99', name: 'web_search', arguments: {} },
          ],
        },
      },
    });
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        partial: {
          content: [
            {
              type: 'toolCall',
              id: 'call-99',
              name: 'web_search',
              arguments: { query: 'action inference' },
            },
          ],
        },
        toolCall: {
          type: 'toolCall',
          id: 'call-99',
          name: 'web_search',
          arguments: { query: 'action inference' },
        },
      },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(starts[0]?.shardId).toBe('shard-xyz');
    expect(deltas[0]?.shardId).toBe('shard-xyz');
    expect(ends[0]?.shardId).toBe('shard-xyz');
  });

  it('stops emitting after clearChannel', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'before' },
    });

    bridge.clearChannel();
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'after' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual(['before']);
  });

  it('destroy stops all event emission', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: string[] = [];
    eventBus.on('agent.stream.delta', ({ text }) => { deltas.push(text); });

    bridge.setChannel('test-channel');
    bridge.destroy();

    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'after destroy' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual([]);
  });

  it('ignores non-text_delta message_update events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const handler = vi.fn();
    eventBus.on('agent.stream.delta', handler);

    bridge.setChannel('test-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'tool_use', toolCallId: 'x', toolName: 'y' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('includes correct channelId in all events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const channelIds: string[] = [];
    eventBus.on('agent.stream.delta', ({ channelId }) => { channelIds.push(channelId); });
    eventBus.on('agent.tool.start', ({ channelId }) => { channelIds.push(channelId); });
    eventBus.on('agent.tool.end', ({ channelId }) => { channelIds.push(channelId); });

    bridge.setChannel('my-channel');
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
    });
    emitAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'c1', toolName: 't1', args: {},
    });
    emitAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'c1', toolName: 't1', result: {}, isError: false,
    });

    await new Promise(r => setTimeout(r, 10));
    expect(channelIds).toEqual(['my-channel', 'my-channel', 'my-channel']);
  });

  it('keeps the latest context active when clearing an older channel token', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const deltas: Array<{ channelId: string; text: string }> = [];
    eventBus.on('agent.stream.delta', ({ channelId, text }) => {
      deltas.push({ channelId, text });
    });

    const olderToken = bridge.setChannel('channel-a');
    const newerToken = bridge.setChannel('channel-b');

    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'first' },
    });

    bridge.clearChannel(olderToken);
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'second' },
    });

    bridge.clearChannel(newerToken);
    emitAgentEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'ignored' },
    });

    await new Promise(r => setTimeout(r, 10));
    expect(deltas).toEqual([
      { channelId: 'channel-b', text: 'first' },
      { channelId: 'channel-b', text: 'second' },
    ]);
  });

  it('preserves background origin correlation on tool events', async () => {
    const bridge = createEventBridge(agent, eventBus);
    const events: any[] = [];
    eventBus.on('agent.tool.start', (data) => { events.push(data); });

    bridge.setChannel('background-channel', {
      callType: 'background',
      originType: 'background',
      originStage: 'agent.background.turn',
      purpose: 'agent.background.turn',
    });
    emitAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-bg-1',
      toolName: 'analysis_workbench',
      args: {},
    });

    await new Promise(r => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: 'background-channel',
      callType: 'tool',
      originType: 'background',
      originStage: 'agent.background.turn',
      purpose: 'agent.background.turn',
    });
  });
});
