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
