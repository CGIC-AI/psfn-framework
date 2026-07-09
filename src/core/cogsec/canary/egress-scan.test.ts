import { describe, expect, it } from 'vitest';
import { CANARY_CARRIER_PARAM_KEY, generateCanaryToken } from './canary-token.js';
import {
  EGRESS_CANARY_METHODS,
  isEgressCanaryMethod,
  readCanaryCarrier,
  scanEgressParamsForCanary,
  stripCanaryCarrier,
} from './egress-scan.js';

describe('egress method set', () => {
  it('covers the outbound free-text methods and excludes provider calls', () => {
    expect(isEgressCanaryMethod('discord.send')).toBe(true);
    expect(isEgressCanaryMethod('notify.ntfy')).toBe(true);
    expect(isEgressCanaryMethod('web.fetch')).toBe(true);
    expect(isEgressCanaryMethod('web.search')).toBe(true);
    // Provider calls carry the canary in the prompt legitimately.
    expect(isEgressCanaryMethod('llm.chat')).toBe(false);
    expect(isEgressCanaryMethod('fs.read')).toBe(false);
    expect(EGRESS_CANARY_METHODS.has('discord.sendMedia')).toBe(true);
  });
});

describe('scanEgressParamsForCanary', () => {
  it('catches a leak echoed into a top-level message field', () => {
    const token = generateCanaryToken();
    const result = scanEgressParamsForCanary(
      { channelId: 'c1', content: `sure, here it is: ${token}` },
      token,
    );
    expect(result).toEqual({ leaked: true, reason: 'token_present' });
  });

  it('catches a leak nested deep inside a tool param object', () => {
    const token = generateCanaryToken();
    const result = scanEgressParamsForCanary(
      { url: 'https://example.test', body: { meta: { note: [`x=${token}`] } } },
      token,
    );
    expect(result).toEqual({ leaked: true, reason: 'token_present' });
  });

  it('does not flag a benign send', () => {
    const token = generateCanaryToken();
    const result = scanEgressParamsForCanary(
      { channelId: 'c1', content: 'hello, how are you today?' },
      token,
    );
    expect(result).toEqual({ leaked: false });
  });

  it('isolates sessions: session B token never matches session A content', () => {
    const tokenA = generateCanaryToken();
    const tokenB = generateCanaryToken();
    // An outbound message in session B that happens to contain session A's token
    // is scanned only against session B's token → not held by B's scan.
    const result = scanEgressParamsForCanary(
      { channelId: 'c1', content: `leftover ${tokenA}` },
      tokenB,
    );
    expect(result).toEqual({ leaked: false });
  });

  it('fails closed when the param graph exceeds scan bounds', () => {
    const token = generateCanaryToken();
    // A pathologically deep structure trips the depth bound.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    const result = scanEgressParamsForCanary(deep, token);
    expect(result).toEqual({ leaked: true, reason: 'scan_bound_exceeded' });
  });

  it('scans a 100KB payload in well under a few milliseconds', () => {
    const token = generateCanaryToken();
    const big = 'x'.repeat(100 * 1024);
    const start = performance.now();
    const result = scanEgressParamsForCanary({ content: big }, token);
    const elapsedMs = performance.now() - start;
    expect(result).toEqual({ leaked: false });
    expect(elapsedMs).toBeLessThan(20);
  });

  it('never scans the reserved carrier field (no self-hit)', () => {
    const token = generateCanaryToken();
    const result = scanEgressParamsForCanary(
      { channelId: 'c1', content: 'benign', [CANARY_CARRIER_PARAM_KEY]: token },
      token,
    );
    expect(result).toEqual({ leaked: false });
  });
});

describe('carrier helpers', () => {
  it('reads and strips the carrier field', () => {
    const token = generateCanaryToken();
    const params = { channelId: 'c1', content: 'hi', [CANARY_CARRIER_PARAM_KEY]: token };
    expect(readCanaryCarrier(params)).toBe(token);
    const stripped = stripCanaryCarrier(params) as Record<string, unknown>;
    expect(stripped).toEqual({ channelId: 'c1', content: 'hi' });
    expect(CANARY_CARRIER_PARAM_KEY in stripped).toBe(false);
    // Original object is not mutated.
    expect(readCanaryCarrier(params)).toBe(token);
  });

  it('returns undefined / passthrough when there is no carrier', () => {
    expect(readCanaryCarrier({ channelId: 'c1' })).toBeUndefined();
    expect(stripCanaryCarrier({ channelId: 'c1' })).toEqual({ channelId: 'c1' });
    expect(readCanaryCarrier('not-an-object')).toBeUndefined();
  });
});
