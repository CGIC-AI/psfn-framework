import { describe, expect, it } from 'vitest';
import {
  captureReplyCanary,
  getReplyCanaryCaptureToken,
  recordReplyCanaryToken,
} from './reply-canary.js';
import { CANARY_CARRIER_PARAM_KEY, generateCanaryToken } from './canary-token.js';

describe('canary reply capture (d269)', () => {
  it('attaches the recorded session canary to an object reply result', async () => {
    const token = generateCanaryToken();
    const result = await captureReplyCanary(async () => {
      // Simulates turn execution planting the canary mid-handler.
      recordReplyCanaryToken(token);
      return { content: 'hello', channelId: 'chan-1' };
    });
    expect(result).toEqual({
      content: 'hello',
      channelId: 'chan-1',
      [CANARY_CARRIER_PARAM_KEY]: token,
    });
  });

  it('propagates the capture across nested async boundaries', async () => {
    const token = generateCanaryToken();
    const result = await captureReplyCanary(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      await (async () => {
        recordReplyCanaryToken(token);
      })();
      expect(getReplyCanaryCaptureToken()).toBe(token);
      return { content: 'nested' };
    });
    expect((result as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY]).toBe(token);
  });

  it('leaves the result untouched when no token is recorded (CogSec off / non-canary turn)', async () => {
    const result = await captureReplyCanary(async () => ({ content: 'plain' }));
    expect(result).toEqual({ content: 'plain' });
    expect(CANARY_CARRIER_PARAM_KEY in result).toBe(false);
  });

  it('passes non-object results through unchanged even with a recorded token', async () => {
    const token = generateCanaryToken();
    const result = await captureReplyCanary(async () => {
      recordReplyCanaryToken(token);
      return 'bare string result';
    });
    expect(result).toBe('bare string result');
  });

  it('is a no-op to record outside an active capture', () => {
    expect(() => recordReplyCanaryToken(generateCanaryToken())).not.toThrow();
    expect(getReplyCanaryCaptureToken()).toBeUndefined();
  });

  it('isolates captures between concurrent handlers', async () => {
    const tokenA = generateCanaryToken();
    const tokenB = generateCanaryToken();
    const [a, b] = await Promise.all([
      captureReplyCanary(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        recordReplyCanaryToken(tokenA);
        return { content: 'a' };
      }),
      captureReplyCanary(async () => {
        recordReplyCanaryToken(tokenB);
        await new Promise(resolve => setTimeout(resolve, 10));
        return { content: 'b' };
      }),
    ]);
    expect((a as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY]).toBe(tokenA);
    expect((b as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY]).toBe(tokenB);
  });

  it('does not attach a carrier when the handler throws', async () => {
    const token = generateCanaryToken();
    await expect(captureReplyCanary(async () => {
      recordReplyCanaryToken(token);
      throw new Error('turn failed');
    })).rejects.toThrow('turn failed');
  });
});
