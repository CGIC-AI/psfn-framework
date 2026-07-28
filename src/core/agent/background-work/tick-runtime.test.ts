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

  it('bounds retained failures while still attempting and indexing the full snapshot', async () => {
    const records = Array.from({ length: 100 }, (_, index) => `record-${index}`);
    const deferred: string[] = [];

    await expect(recoverHistoricalBackgroundWorkHandoffs(
      records,
      async (record) => { throw new Error(`failed: ${record}`); },
      record => { deferred.push(record); },
    )).rejects.toMatchObject({
      errors: [
        ...records.slice(0, 16).map(record => expect.objectContaining({ message: `failed: ${record}` })),
        expect.objectContaining({ message: '84 additional historical background work handoff failures were suppressed' }),
      ],
    });

    expect(deferred).toEqual(records);
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
