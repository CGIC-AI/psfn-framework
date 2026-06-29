import { describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from './circuit-breaker.js';

describe('SlidingWindowCircuitBreaker', () => {
  it('opens after the sliding-window failure threshold and short-circuits calls', async () => {
    let now = 1_000;
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 30_000,
      now: () => now,
    });
    const operation = vi.fn(async () => {
      throw new Error('503 service unavailable');
    });

    await expect(breaker.execute({
      key: 'llm.complete::openrouter::model-a',
      operation,
    })).rejects.toThrow('503 service unavailable');
    now += 1_000;
    await expect(breaker.execute({
      key: 'llm.complete::openrouter::model-a',
      operation,
    })).rejects.toThrow('503 service unavailable');
    now += 1_000;

    await expect(breaker.execute({
      key: 'llm.complete::openrouter::model-a',
      operation,
    })).rejects.toBeInstanceOf(CircuitOpenError);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(breaker.snapshot('llm.complete::openrouter::model-a').state).toBe('open');
  });

  it('moves to half-open after cooldown and closes after a successful probe', async () => {
    let now = 5_000;
    const transitions: string[] = [];
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      cooldownMs: 20_000,
      now: () => now,
    });

    await expect(breaker.execute({
      key: 'web.fetch::https://example.test/down',
      operation: async () => {
        throw new Error('Fetch failed: 503');
      },
      onTransition: transition => transitions.push(`${transition.from}->${transition.to}:${transition.reason}`),
    })).rejects.toThrow('Fetch failed: 503');

    await expect(breaker.execute({
      key: 'web.fetch::https://example.test/down',
      operation: async () => 'blocked',
    })).rejects.toBeInstanceOf(CircuitOpenError);

    now += 20_001;
    const result = await breaker.execute({
      key: 'web.fetch::https://example.test/down',
      operation: async () => 'ok',
      onTransition: transition => transitions.push(`${transition.from}->${transition.to}:${transition.reason}`),
    });

    expect(result).toBe('ok');
    expect(breaker.snapshot('web.fetch::https://example.test/down').state).toBe('closed');
    expect(transitions).toEqual([
      'closed->open:failure_threshold',
      'open->half_open:cooldown_elapsed',
      'half_open->closed:half_open_success',
    ]);
  });

  it('keeps independent circuits per key and reopens on half-open failure', async () => {
    let now = 10_000;
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      cooldownMs: 5_000,
      now: () => now,
    });

    await expect(breaker.execute({
      key: 'shell.exec::node::/workspace-a',
      operation: async () => {
        throw new Error('exit 1');
      },
    })).rejects.toThrow('exit 1');

    const healthy = await breaker.execute({
      key: 'shell.exec::node::/workspace-b',
      operation: async () => 'still allowed',
    });

    expect(healthy).toBe('still allowed');
    expect(breaker.snapshot('shell.exec::node::/workspace-a').state).toBe('open');
    expect(breaker.snapshot('shell.exec::node::/workspace-b').state).toBe('closed');

    now += 5_001;
    await expect(breaker.execute({
      key: 'shell.exec::node::/workspace-a',
      operation: async () => {
        throw new Error('still failing');
      },
    })).rejects.toThrow('still failing');

    expect(breaker.snapshot('shell.exec::node::/workspace-a').state).toBe('open');
  });
});
