export interface AutomataMutationSqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}

export interface AutomataMutationSqlPool {
  connect(): Promise<AutomataMutationSqlClient>;
}

function requiredCompanionId(value: string): string {
  const companionId = value.trim();
  if (!companionId) {
    throw new Error('Automata mutation fence companionId must be a non-empty string');
  }
  return companionId;
}

/**
 * One database-wide companion lock shared by Bus appends, run/artifact writes,
 * immutable session classification, and exact-session purge. The deliberately
 * coarse scope prevents a proof writer from changing any represented state
 * between the purge's final revalidation and irreversible deletion.
 */
export class PostgresAutomataCompanionMutationFence {
  constructor(private readonly pool: AutomataMutationSqlPool) {}

  async runExclusive<T>(
    input: { companionId: string },
    operation: (client: AutomataMutationSqlClient) => Promise<T>,
  ): Promise<T> {
    const companionId = requiredCompanionId(input.companionId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Keep this statement identical to the canonical Bus append transaction.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companionId]);
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Automata fenced mutation failed and transaction rollback also failed',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
