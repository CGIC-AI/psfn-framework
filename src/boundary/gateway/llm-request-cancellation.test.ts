import { describe, expect, it, vi } from 'vitest';
import { GatewayLLMRequestCancellation } from './llm-request-cancellation.js';

describe('GatewayLLMRequestCancellation', () => {
  it('reserves synchronously and aborts only the matching opaque request', async () => {
    const registry = new GatewayLLMRequestCancellation();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    const first = registry.run(
      '11111111-1111-4111-8111-111111111111',
      signal => {
        firstSignal = signal;
        return new Promise(() => {});
      },
    );
    const second = registry.run(
      '22222222-2222-4222-8222-222222222222',
      signal => {
        secondSignal = signal;
        return new Promise(() => {});
      },
    );

    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(registry.cancel('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    expect(registry.cancel('33333333-3333-4333-8333-333333333333')).toBe(false);
    await expect(first).rejects.toThrow('cancelled by its owning connection');
    registry.abortAll();
    await expect(second).rejects.toThrow('connection closed');
  });

  it('releases settled requests and aborts every live request on connection cleanup', async () => {
    const registry = new GatewayLLMRequestCancellation();
    const settled = await registry.run(
      '11111111-1111-4111-8111-111111111111',
      async () => 'done',
    );
    expect(settled).toBe('done');
    expect(registry.cancel('11111111-1111-4111-8111-111111111111')).toBe(false);

    const signals: AbortSignal[] = [];
    const first = registry.run(
      '22222222-2222-4222-8222-222222222222',
      signal => {
        signals.push(signal!);
        return new Promise(() => {});
      },
    );
    const second = registry.run(
      '33333333-3333-4333-8333-333333333333',
      signal => {
        signals.push(signal!);
        return new Promise(() => {});
      },
    );

    expect(registry.abortAll()).toBe(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(registry.cancel('22222222-2222-4222-8222-222222222222')).toBe(false);
    await expect(first).rejects.toThrow('connection closed');
    await expect(second).rejects.toThrow('connection closed');
  });

  it('rejects malformed and duplicate cancellation identities without replacing the owner', async () => {
    const registry = new GatewayLLMRequestCancellation();
    let ownerSignal: AbortSignal | undefined;
    const owner = registry.run(
      '11111111-1111-4111-8111-111111111111',
      signal => {
        ownerSignal = signal;
        return new Promise(() => {});
      },
    );

    await expect(registry.run(
      '11111111-1111-4111-8111-111111111111',
      vi.fn(async () => 'duplicate'),
    )).rejects.toThrow('already active');
    expect(() => registry.cancel('not-an-opaque-id')).toThrow('canonical UUID');
    expect(ownerSignal?.aborted).toBe(false);
    registry.abortAll();
    await expect(owner).rejects.toThrow('connection closed');
  });

  it('settles as cancelled once even when a provider ignores abort and resolves late', async () => {
    const registry = new GatewayLLMRequestCancellation();
    let resolveProvider!: (value: string) => void;
    const pending = registry.run(
      '11111111-1111-4111-8111-111111111111',
      () => new Promise<string>(resolve => {
        resolveProvider = resolve;
      }),
    );

    expect(registry.cancel('11111111-1111-4111-8111-111111111111')).toBe(true);
    resolveProvider('late success');

    await expect(pending).rejects.toThrow('cancelled by its owning connection');
    expect(registry.cancel('11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});
