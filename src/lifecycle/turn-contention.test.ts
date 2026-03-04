import { describe, expect, it, vi } from 'vitest';
import {
  DeferredLatestByChannel,
  FifoChannelLock,
  emitTurnContentionTelemetry,
  isBusyTurnError,
} from './turn-contention.js';

describe('emitTurnContentionTelemetry', () => {
  it('emits channel queue telemetry with a timestamp', () => {
    const emit = vi.fn(async () => undefined);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_710_000_000_000);
    try {
      emitTurnContentionTelemetry({ emit }, {
        channelId: 'discord:123',
        phase: 'acquired',
        policy: 'queue',
        source: 'discord',
        queueDepth: 0,
        waitMs: 12,
        processingChannels: 1,
      });

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('channel.queue.telemetry', {
        channelId: 'discord:123',
        phase: 'acquired',
        policy: 'queue',
        source: 'discord',
        queueDepth: 0,
        waitMs: 12,
        processingChannels: 1,
        timestamp: 1_710_000_000_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('swallows telemetry emit rejections', async () => {
    const emit = vi.fn(async () => {
      throw new Error('emit failed');
    });

    expect(() => {
      emitTurnContentionTelemetry({ emit }, {
        channelId: 'telegram:123',
        phase: 'released',
        policy: 'defer-latest',
        source: 'telegram',
        queueDepth: 1,
        waitMs: 22,
        processingChannels: 0,
      });
    }).not.toThrow();

    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('isBusyTurnError', () => {
  it('matches known busy markers case-insensitively', () => {
    expect(isBusyTurnError('Already PROCESSING this channel')).toBe(true);
    expect(isBusyTurnError(new Error('AGENT_BUSY while another turn runs'))).toBe(true);
    expect(isBusyTurnError({ toString: () => 'CHANNEL_BUSY' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isBusyTurnError('model not found')).toBe(false);
    expect(isBusyTurnError(undefined)).toBe(false);
  });
});

describe('DeferredLatestByChannel', () => {
  it('keeps only the latest deferred value for a channel', () => {
    const queue = new DeferredLatestByChannel<string>();

    expect(queue.set('ch-1', 'first')).toEqual({ replaced: false, queueDepth: 1 });
    expect(queue.depth('ch-1')).toBe(1);
    expect(queue.set('ch-1', 'second')).toEqual({ replaced: true, queueDepth: 1 });

    expect(queue.take('ch-1')).toBe('second');
    expect(queue.depth('ch-1')).toBe(0);
    expect(queue.take('ch-1')).toBeUndefined();
  });

  it('tracks deferred values independently per channel', () => {
    const queue = new DeferredLatestByChannel<number>();

    queue.set('alpha', 1);
    queue.set('beta', 2);

    expect(queue.take('alpha')).toBe(1);
    expect(queue.depth('alpha')).toBe(0);
    expect(queue.depth('beta')).toBe(1);
    expect(queue.take('beta')).toBe(2);
  });
});

describe('FifoChannelLock', () => {
  it('resolves waiters in FIFO order and reports queued delay', async () => {
    let now = 100;
    const lock = new FifoChannelLock({ now: () => now });

    const first = lock.acquire('chan');
    expect(first.contended).toBe(false);
    expect(first.queueDepth).toBe(0);
    expect(lock.pending('chan')).toBe(1);

    const second = lock.acquire('chan');
    expect(second.contended).toBe(true);
    expect(second.queueDepth).toBe(1);
    expect(lock.pending('chan')).toBe(2);

    const firstLease = await first.lease;
    expect(firstLease.queuedAhead).toBe(0);
    expect(firstLease.waitMs).toBe(0);

    let secondResolved = false;
    void second.lease.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    now = 325;
    firstLease.release();
    const secondLease = await second.lease;

    expect(secondResolved).toBe(true);
    expect(secondLease.queuedAhead).toBe(1);
    expect(secondLease.waitMs).toBe(225);
    expect(lock.pending('chan')).toBe(1);

    secondLease.release();
    expect(lock.pending('chan')).toBe(0);
  });

  it('supports cancellation pattern by releasing a late-resolved lease', async () => {
    const lock = new FifoChannelLock();
    const first = lock.acquire('chan');
    const cancelled = lock.acquire('chan');

    const firstLease = await first.lease;
    void cancelled.lease.then((lease) => {
      lease.release();
    });

    firstLease.release();
    await cancelled.lease;
    await Promise.resolve();

    expect(lock.pending('chan')).toBe(0);

    const next = lock.acquire('chan');
    expect(next.contended).toBe(false);
    const nextLease = await next.lease;
    nextLease.release();
  });

  it('makes release idempotent', async () => {
    const lock = new FifoChannelLock();
    const acquired = lock.acquire('chan');
    const lease = await acquired.lease;

    lease.release();
    lease.release();

    expect(lock.pending('chan')).toBe(0);
  });

  it('never reports negative wait times when clock moves backward', async () => {
    let now = 50;
    const lock = new FifoChannelLock({ now: () => now });

    const acquired = lock.acquire('chan');
    now = 20;
    const lease = await acquired.lease;

    expect(lease.waitMs).toBe(0);
    lease.release();
  });

  it('does not serialize different channels', async () => {
    const lock = new FifoChannelLock();
    const alpha = lock.acquire('alpha');
    const beta = lock.acquire('beta');

    expect(alpha.contended).toBe(false);
    expect(beta.contended).toBe(false);

    const alphaLease = await alpha.lease;
    const betaLease = await beta.lease;
    expect(alphaLease.queuedAhead).toBe(0);
    expect(betaLease.queuedAhead).toBe(0);

    alphaLease.release();
    betaLease.release();
    expect(lock.pending('alpha')).toBe(0);
    expect(lock.pending('beta')).toBe(0);
  });
});
