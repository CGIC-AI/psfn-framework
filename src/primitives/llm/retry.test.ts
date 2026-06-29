import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';
import {
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from '../../shared/resilience/circuit-breaker.js';

describe('withRetry', () => {
  it('retries retryable errors and eventually succeeds', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async (_ms: number) => {});
    const onRetry = vi.fn((_info: { attempt: number; delayMs: number }) => {});

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 25 }, { sleep, onRetry });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      delayMs: 25,
    }));
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('throws after retry budget is exhausted', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValue(new Error('503 service unavailable'));
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }, { sleep }),
    ).rejects.toThrow('503 service unavailable');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('fails fast for non-retryable errors', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValue(new Error('401 unauthorized'));
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }, { sleep }),
    ).rejects.toThrow('401 unauthorized');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('opens a circuit after exhausted retryable failures and short-circuits later calls', async () => {
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 30_000,
    });
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValue(new Error('503 service unavailable'));
    const sleep = vi.fn(async (_ms: number) => {});
    const circuitBreaker = {
      breaker,
      key: 'llm.complete::openrouter::model-a',
      method: 'llm.complete',
    };

    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1 }, { sleep, circuitBreaker }),
    ).rejects.toThrow('503 service unavailable');
    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1 }, { sleep, circuitBreaker }),
    ).rejects.toThrow('503 service unavailable');
    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1 }, { sleep, circuitBreaker }),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not count non-retryable failures against the circuit', async () => {
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 30_000,
    });
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValue(new Error('401 unauthorized'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 1 }, {
        sleep: vi.fn(async (_ms: number) => {}),
        circuitBreaker: {
          breaker,
          key: 'llm.complete::openrouter::model-a',
          method: 'llm.complete',
        },
      }),
    ).rejects.toThrow('401 unauthorized');

    expect(breaker.snapshot('llm.complete::openrouter::model-a').state).toBe('closed');
  });
});
