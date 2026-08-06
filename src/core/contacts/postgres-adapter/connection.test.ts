import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { queryOne, queryRows } from './connection.js';

interface ExampleRow {
  id: string;
  count: number;
}

function stubPool(rows: ExampleRow[]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows });
  return {
    pool: { query } as unknown as Pool,
    query,
  };
}

describe('Postgres contact query helpers', () => {
  it('returns typed rows and forwards a mutable copy of bind values', async () => {
    const { pool, query } = stubPool([{ id: 'contact-1', count: 2 }]);
    const values = ['primary', 2] as const;

    const rows = await queryRows<ExampleRow>(pool, 'SELECT id, count FROM contacts', values);

    expect(rows).toEqual([{ id: 'contact-1', count: 2 }]);
    expect(query).toHaveBeenCalledWith('SELECT id, count FROM contacts', ['primary', 2]);
    expect(query.mock.calls[0]?.[1]).not.toBe(values);
  });

  it('returns only the first typed row, or undefined for an empty result', async () => {
    const populated = stubPool([
      { id: 'contact-1', count: 2 },
      { id: 'contact-2', count: 3 },
    ]);
    const empty = stubPool([]);

    await expect(queryOne<ExampleRow>(populated.pool, 'SELECT id, count FROM contacts'))
      .resolves.toEqual({ id: 'contact-1', count: 2 });
    await expect(queryOne<ExampleRow>(empty.pool, 'SELECT id, count FROM contacts'))
      .resolves.toBeUndefined();
  });
});
