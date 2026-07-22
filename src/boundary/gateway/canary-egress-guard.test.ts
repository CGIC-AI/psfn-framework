import { describe, expect, it, vi } from 'vitest';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { createCanaryEgressGuard, CANARY_HELD_NOTICE } from './canary-egress-guard.js';
import { GatewayErrors } from './protocol.js';
import {
  CANARY_CARRIER_PARAM_KEY,
  generateCanaryToken,
  hashCanaryToken,
} from '../../core/cogsec/canary/canary-token.js';
import type { CogSecCreateEventInput, CogSecEvent } from '../../core/cogsec/events.js';
import { isIntakeFirewallNoticeText } from '../../core/cogsec/intake-firewall-notice-templates.js';

function makeFakeEventStore(): {
  createEvent: (input: CogSecCreateEventInput) => CogSecEvent;
  inputs: CogSecCreateEventInput[];
} {
  const inputs: CogSecCreateEventInput[] = [];
  return {
    inputs,
    createEvent(input: CogSecCreateEventInput): CogSecEvent {
      inputs.push(input);
      return { caseId: 'cogsec_test', ...input } as unknown as CogSecEvent;
    },
  };
}

function makeLog(): { warn: ReturnType<typeof vi.fn>; lines: unknown[] } {
  const lines: unknown[] = [];
  const warn = vi.fn((message: string, meta?: Record<string, unknown>) => {
    lines.push({ message, meta });
  });
  return { warn, lines };
}

describe('canary egress guard', () => {
  it('holds an outbound message that echoes the session canary', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const log = makeLog();
    const guard = createCanaryEgressGuard({ cogSecEvents: store, log });

    let thrown: unknown;
    try {
      guard.inspect('discord.send', {
        channelId: 'chan-1',
        content: `here is the marker: ${token}`,
        [CANARY_CARRIER_PARAM_KEY]: token,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JSONRPCErrorException);
    const err = thrown as JSONRPCErrorException;
    expect(err.code).toBe(GatewayErrors.EGRESS_HELD);
    // The companion sees the calm, operator-reviewed soft notice.
    expect(err.message).toBe(CANARY_HELD_NOTICE);
    expect(isIntakeFirewallNoticeText(err.message)).toBe(true);

    // A durable CogSecEvent was written recording ONLY the sha256 digest.
    expect(store.inputs).toHaveLength(1);
    const event = store.inputs[0];
    expect(event.type).toBe('prompt_injection');
    expect(event.sourceChannelId).toBe('chan-1');
    expect(event.sealedForensicPayloadHashes).toEqual([hashCanaryToken(token)]);
  });

  it('holds a leak nested inside a tool param', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    expect(() => guard.inspect('web.fetch', {
      url: 'https://example.test',
      prompt: { note: [`x=${token}`] },
      [CANARY_CARRIER_PARAM_KEY]: token,
    })).toThrow(JSONRPCErrorException);
    expect(store.inputs).toHaveLength(1);
  });

  it('records but allows a would-hold leak in shadow mode', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const recordAudit = vi.fn();
    const guard = createCanaryEgressGuard({
      mode: 'shadow',
      cogSecEvents: store,
      recordAudit,
    });

    const cleaned = guard.inspect('discord.send', {
      channelId: 'chan-shadow',
      content: `observed ${token}`,
      [CANARY_CARRIER_PARAM_KEY]: token,
    });

    expect(cleaned).toEqual({
      channelId: 'chan-shadow',
      content: `observed ${token}`,
    });
    expect(store.inputs).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      method: 'discord.send',
      decision: 'ALLOW',
      params: expect.objectContaining({ canaryEgressWouldHold: true }),
    }));
  });

  it('never exposes the raw token in the event or logs (cleartext-free)', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const log = makeLog();
    const guard = createCanaryEgressGuard({ cogSecEvents: store, log });
    expect(() => guard.inspect('discord.send', {
      channelId: 'chan-1',
      content: `leak ${token}`,
      [CANARY_CARRIER_PARAM_KEY]: token,
    })).toThrow();

    const serializedEvents = JSON.stringify(store.inputs);
    const serializedLogs = JSON.stringify(log.lines);
    expect(serializedEvents).not.toContain(token);
    expect(serializedLogs).not.toContain(token);
    // The digest IS present in the event.
    expect(serializedEvents).toContain(hashCanaryToken(token));
  });

  it('passes a benign send through with the carrier stripped', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    const cleaned = guard.inspect('discord.send', {
      channelId: 'chan-1',
      content: 'hello there',
      [CANARY_CARRIER_PARAM_KEY]: token,
    }) as Record<string, unknown>;
    expect(cleaned).toEqual({ channelId: 'chan-1', content: 'hello there' });
    expect(CANARY_CARRIER_PARAM_KEY in cleaned).toBe(false);
    expect(store.inputs).toHaveLength(0);
  });

  it('leaves non-egress methods untouched', () => {
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    const params = { model: 'x', messages: [] };
    expect(guard.inspect('llm.chat', params)).toBe(params);
    expect(store.inputs).toHaveLength(0);
  });

  it('does not hold when no canary rode with the request', () => {
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    // Out-of-turn proactive send: no carrier, nothing to compare against.
    const cleaned = guard.inspect('notify.ntfy', { topic: 't', message: 'ping' });
    expect(cleaned).toEqual({ topic: 't', message: 'ping' });
    expect(store.inputs).toHaveLength(0);
  });

  it('holds session B outbound content only against session B token', () => {
    const tokenA = generateCanaryToken();
    const tokenB = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    // Content carries token A but the request's canary is token B → not held.
    const cleaned = guard.inspect('discord.send', {
      channelId: 'chan-b',
      content: `stale ${tokenA}`,
      [CANARY_CARRIER_PARAM_KEY]: tokenB,
    });
    expect(cleaned).toEqual({ channelId: 'chan-b', content: `stale ${tokenA}` });
    expect(store.inputs).toHaveLength(0);
  });
});

describe('canary reply guard (d269: main conversational reply over the reverse-RPC seam)', () => {
  it('holds a voice reply that echoes the session canary in enforce mode', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const log = makeLog();
    const guard = createCanaryEgressGuard({ cogSecEvents: store, log });

    let thrown: unknown;
    try {
      guard.inspectReply('voice.transcript.end', {
        content: `the marker is ${token}`,
        channelId: 'telegram:123',
        model: 'm',
        durationMs: 10,
        [CANARY_CARRIER_PARAM_KEY]: token,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JSONRPCErrorException);
    const err = thrown as JSONRPCErrorException;
    expect(err.code).toBe(GatewayErrors.EGRESS_HELD);
    expect(err.message).toBe(CANARY_HELD_NOTICE);
    expect(store.inputs).toHaveLength(1);
    expect(store.inputs[0].type).toBe('prompt_injection');
    expect(store.inputs[0].sourceChannelId).toBe('telegram:123');
    expect(store.inputs[0].sealedForensicPayloadHashes).toEqual([hashCanaryToken(token)]);
    // Raw token never enters events or logs.
    expect(JSON.stringify(store.inputs)).not.toContain(token);
    expect(JSON.stringify(log.lines)).not.toContain(token);
  });

  it('holds an api.chat.completion reply and resolves the nested response channel', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    expect(() => guard.inspectReply('api.chat.completion', {
      ok: true,
      response: {
        content: `leak ${token}`,
        channelId: 'api:req-1',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
      },
      [CANARY_CARRIER_PARAM_KEY]: token,
    })).toThrow(JSONRPCErrorException);
    expect(store.inputs).toHaveLength(1);
    expect(store.inputs[0].sourceChannelId).toBe('api:req-1');
  });

  it('passes a clean reply through with the carrier stripped', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    const cleaned = guard.inspectReply('voice.handleMessage', {
      content: 'a perfectly ordinary reply',
      channelId: 'chan-1',
      model: 'm',
      durationMs: 5,
      [CANARY_CARRIER_PARAM_KEY]: token,
    }) as Record<string, unknown>;
    expect(cleaned).toEqual({
      content: 'a perfectly ordinary reply',
      channelId: 'chan-1',
      model: 'm',
      durationMs: 5,
    });
    expect(CANARY_CARRIER_PARAM_KEY in cleaned).toBe(false);
    expect(store.inputs).toHaveLength(0);
  });

  it('passes a carrier-free reply through untouched (no token, nothing to hold)', () => {
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    const result = { content: 'hello', channelId: 'chan-1', model: 'm', durationMs: 5 };
    expect(guard.inspectReply('voice.transcript.end', result)).toEqual(result);
    expect(store.inputs).toHaveLength(0);
  });

  it('records but allows a leaked reply in shadow mode', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ mode: 'shadow', cogSecEvents: store });
    const cleaned = guard.inspectReply('api.chat.completion', {
      ok: true,
      response: { content: `observed ${token}`, channelId: 'api:req-2' },
      [CANARY_CARRIER_PARAM_KEY]: token,
    }) as Record<string, unknown>;
    expect(cleaned).toEqual({
      ok: true,
      response: { content: `observed ${token}`, channelId: 'api:req-2' },
    });
    expect(store.inputs).toHaveLength(1);
    expect(store.inputs[0].safeAgentSummary).toContain('shadow mode');
  });

  it('fails closed when the reply scan hits a bound (enforce holds)', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    // Nest deeper than the scanner's MAX_DEPTH so the walk aborts.
    let nested: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 12; i += 1) {
      nested = { child: nested };
    }
    expect(() => guard.inspectReply('voice.transcript.end', {
      content: 'clean',
      deep: nested,
      [CANARY_CARRIER_PARAM_KEY]: token,
    })).toThrow(JSONRPCErrorException);
    expect(store.inputs).toHaveLength(1);
  });
});

describe('canary stream-delta guard (d269: streamed reply frames)', () => {
  it('drops a frame carrying the canary and closes the stream tap in enforce mode', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const log = makeLog();
    const guard = createCanaryEgressGuard({ cogSecEvents: store, log });

    expect(guard.inspectApiStreamDelta({
      requestId: 'req-1', text: 'benign prefix ', token,
    })).toEqual({ forward: true });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-1', text: `then ${token} leaks`, token,
    })).toEqual({ forward: false });
    // The stream stays closed for its remainder, even for clean frames.
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-1', text: 'clean tail', token,
    })).toEqual({ forward: false });

    expect(store.inputs).toHaveLength(1);
    expect(JSON.stringify(store.inputs)).not.toContain(token);
    expect(JSON.stringify(log.lines)).not.toContain(token);
  });

  it('does not reopen a poisoned stream when clean streams fill the state cache', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });

    expect(guard.inspectApiStreamDelta({
      requestId: 'req-poisoned', text: `leak ${token}`, token,
    })).toEqual({ forward: false });

    // Exceed the bounded state cache with independent clean streams. A
    // poisoned enforce-mode stream must remain closed throughout the flood.
    for (let index = 0; index < 513; index += 1) {
      expect(guard.inspectApiStreamDelta({
        requestId: `req-clean-${index}`, text: 'clean frame', token,
      })).toEqual({ forward: true });
    }

    expect(guard.inspectApiStreamDelta({
      requestId: 'req-poisoned', text: 'clean tail', token,
    })).toEqual({ forward: false });
    expect(store.inputs).toHaveLength(1);
  });

  it('catches a token split across two frames before the completing fragment egresses', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    const split = Math.floor(token.length / 2);
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-split', text: `prefix ${token.slice(0, split)}`, token,
    })).toEqual({ forward: true });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-split', text: `${token.slice(split)} suffix`, token,
    })).toEqual({ forward: false });
    expect(store.inputs).toHaveLength(1);
  });

  it('forwards clean frames and frames with no carried token', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-clean', text: 'hello', token,
    })).toEqual({ forward: true });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-clean', text: 'world', token: undefined,
    })).toEqual({ forward: true });
    expect(store.inputs).toHaveLength(0);
  });

  it('records but keeps forwarding leaked frames in shadow mode (once per request)', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ mode: 'shadow', cogSecEvents: store });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-shadow', text: `frame ${token}`, token,
    })).toEqual({ forward: true });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-shadow', text: `again ${token}`, token,
    })).toEqual({ forward: true });
    expect(store.inputs).toHaveLength(1);
    expect(store.inputs[0].safeAgentSummary).toContain('shadow mode');
  });

  it('scopes stream scan state per requestId', () => {
    const token = generateCanaryToken();
    const store = makeFakeEventStore();
    const guard = createCanaryEgressGuard({ cogSecEvents: store });
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-a', text: `boom ${token}`, token,
    })).toEqual({ forward: false });
    // A different request is unaffected by req-a's poisoned state.
    expect(guard.inspectApiStreamDelta({
      requestId: 'req-b', text: 'independent clean frame', token,
    })).toEqual({ forward: true });
  });
});
