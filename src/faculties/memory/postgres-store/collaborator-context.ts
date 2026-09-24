import type { Pool, QueryResultRow } from 'pg';
import type { PurrMemory } from '../types.js';

/**
 * Narrow capabilities the PostgresMemoryStore facade lends its collaborators.
 * Collaborators receive a `Pick` of this interface instead of the store class,
 * so no extracted module imports the facade (no dependency cycle) and every
 * write still flows through the facade's single serialized persist chain and
 * AsyncLocalStorage transaction scope.
 *
 * The resident L2 memory mirror is reached only through per-call accessors:
 * `runInTransaction` replaces that Map wholesale on rollback, so a collaborator
 * must never retain a reference to it.
 */
export interface PostgresMemoryStoreCollaboratorContext {
  readonly pool: Pool;
  readonly embeddingDims: number;
  /** Serialize a pool-direct write onto the facade persist chain. */
  persist<T>(task: () => Promise<T>): Promise<T>;
  /** Wait for the persist chain to settle (committed-state reads). */
  settle(): Promise<void>;
  hasActiveTransaction(): boolean;
  runInTransaction<T>(handler: () => T): Promise<T>;
  /** Query on the active transaction client when inside one, else the pool. */
  queryWrite<T extends QueryResultRow>(text: string, values: readonly unknown[]): Promise<T[]>;
  getResidentMemory(id: string): PurrMemory | undefined;
  setResidentMemory(id: string, memory: PurrMemory): void;
  /** Upsert the memory row and its subject projection in one transaction. */
  persistClassifiedMemoryRow(memory: PurrMemory, embedding?: Float32Array): Promise<void>;
  markSalienceMaintenanceChanged(): void;
  markRetrievalCorpusChanged(): void;
}
