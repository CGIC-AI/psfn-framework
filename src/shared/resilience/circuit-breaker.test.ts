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

  it('reopens when a concurrent half-open probe fails after another probe succeeded', async () => {
    let now = 1_000;
    const transitions: string[] = [];
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      cooldownMs: 5_000,
      halfOpenMaxAttempts: 2,
      now: () => now,
    });
    const key = 'llm.complete::openrouter::model-a';
    const onTransition = (transition: { from: string; to: string; reason: string }): void => {
      transitions.push(`${transition.from}->${transition.to}:${transition.reason}`);
    };

    await expect(breaker.execute({
      key,
      operation: async () => {
        throw new Error('503 service unavailable');
      },
      onTransition,
    })).rejects.toThrow('503 service unavailable');
    now += 5_001;

    let succeedProbe: (value: string) => void = () => {};
    let failProbe: (error: Error) => void = () => {};
    const probeSuccess = breaker.execute({
      key,
      operation: () => new Promise<string>(resolve => {
        succeedProbe = resolve;
      }),
      onTransition,
    });
    const probeFailure = breaker.execute({
      key,
      operation: () => new Promise<string>((_resolve, reject) => {
        failProbe = reject;
      }),
      onTransition,
    });

    succeedProbe('ok');
    await expect(probeSuccess).resolves.toBe('ok');
    // First probe success alone must not close the circuit while the second
    // probe is still in flight.
    expect(breaker.snapshot(key).state).toBe('half_open');

    failProbe(new Error('still failing'));
    await expect(probeFailure).rejects.toThrow('still failing');

    expect(breaker.snapshot(key).state).toBe('open');
    expect(transitions).toEqual([
      'closed->open:failure_threshold',
      'open->half_open:cooldown_elapsed',
      'half_open->open:half_open_failure',
    ]);
  });

  it('closes only after all allowed half-open probes succeed', async () => {
    let now = 1_000;
    const transitions: string[] = [];
    const breaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      cooldownMs: 5_000,
      halfOpenMaxAttempts: 2,
      now: () => now,
    });
    const key = 'web.fetch::https://example.test/recovering';
    const onTransition = (transition: { from: string; to: string; reason: string }): void => {
      transitions.push(`${transition.from}->${transition.to}:${transition.reason}`);
    };

    await expect(breaker.execute({
      key,
      operation: async () => {
        throw new Error('Fetch failed: 503');
      },
      onTransition,
    })).rejects.toThrow('Fetch failed: 503');
    now += 5_001;

    await expect(breaker.execute({
      key,
      operation: async () => 'first-probe',
      onTransition,
    })).resolves.toBe('first-probe');
    expect(breaker.snapshot(key).state).toBe('half_open');

    await expect(breaker.execute({
      key,
      operation: async () => 'second-probe',
      onTransition,
    })).resolves.toBe('second-probe');

    expect(breaker.snapshot(key).state).toBe('closed');
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
