import { describe, expect, it, vi } from 'vitest';

import {
  recoverHistoricalBackgroundWorkHandoffs,
  runBackgroundWorkTick,
} from './tick-runtime.js';

describe('recoverHistoricalBackgroundWorkHandoffs', () => {
  it('continues the one-time scan and indexes every failed enqueue', async () => {
    const attempts: string[] = [];
    const deferred: string[] = [];

    await expect(recoverHistoricalBackgroundWorkHandoffs(
      ['first', 'second', 'third'],
      async (record) => {
        attempts.push(record);
        if (record !== 'second') throw new Error(`failed: ${record}`);
      },
      (record) => { deferred.push(record); },
    )).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'failed: first' }),
        expect.objectContaining({ message: 'failed: third' }),
      ],
    });

    expect(attempts).toEqual(['first', 'second', 'third']);
    expect(deferred).toEqual(['first', 'third']);
  });
});

describe('runBackgroundWorkTick', () => {
  it('ticks queued work even when pending handoff recovery fails', async () => {
    const recoveryError = new Error('handoff replay failed');
    const tick = vi.fn(async () => undefined);

    await expect(runBackgroundWorkTick({
      recoverHandoffs: async () => { throw recoveryError; },
      tick,
    })).rejects.toBe(recoveryError);

    expect(tick).toHaveBeenCalledOnce();
  });

  it('reports both failures when recovery and the supervisor tick fail', async () => {
    const recoveryError = new Error('handoff replay failed');
    const tickError = new Error('supervisor tick failed');

    await expect(runBackgroundWorkTick({
      recoverHandoffs: async () => { throw recoveryError; },
      tick: async () => { throw tickError; },
    })).rejects.toMatchObject({
      errors: [recoveryError, tickError],
    });
  });
});
