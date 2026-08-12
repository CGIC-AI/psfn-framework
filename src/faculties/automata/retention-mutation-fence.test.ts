import { describe, expect, it, vi } from 'vitest';
import { PostgresAutomataCompanionMutationFence } from './retention-mutation-fence.js';

function harness() {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  const pool = { connect: vi.fn(async () => client) };
  return { calls, client, pool, release };
}

describe('PostgresAutomataCompanionMutationFence', () => {
  it('holds the Bus-compatible companion advisory lock for the whole transaction', async () => {
    const test = harness();
    const fence = new PostgresAutomataCompanionMutationFence(test.pool);

    await expect(fence.runExclusive({ companionId: 'companion-a' }, async client => {
      await client.query('UPDATE proof_state SET revision = revision + 1');
      return 'written';
    })).resolves.toBe('written');

    expect(test.calls).toEqual([
      { text: 'BEGIN', values: undefined },
      {
        text: 'SELECT pg_advisory_xact_lock(hashtext($1))',
        values: ['companion-a'],
      },
      { text: 'UPDATE proof_state SET revision = revision + 1', values: undefined },
      { text: 'COMMIT', values: undefined },
    ]);
    expect(test.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases when a fenced writer fails', async () => {
    const test = harness();
    const fence = new PostgresAutomataCompanionMutationFence(test.pool);

    await expect(fence.runExclusive({ companionId: 'companion-a' }, async () => {
      throw new Error('write failed');
    })).rejects.toThrow('write failed');

    expect(test.calls.map(call => call.text)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'ROLLBACK',
    ]);
    expect(test.release).toHaveBeenCalledOnce();
  });
});
