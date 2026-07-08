import type { Pool } from 'pg';
import { queryRows } from '../../../persistence/postgres.js';
import type {
  MemorySchemaColumnRow,
  MemorySchemaTableRow,
} from './rows.js';

export async function assertExistingMemorySchemaHasEmbeddingColumn(pool: Pool): Promise<void> {
  const tables = await queryRows<MemorySchemaTableRow>(pool, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memories'
  `);
  if (tables.length === 0) return;
  const embeddingColumns = await queryRows<MemorySchemaColumnRow>(pool, `
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memories'
      AND column_name = 'embedding'
  `);
  if (embeddingColumns.length === 0) {
    throw new Error(
      'PostgreSQL memory schema is missing l2_memories.embedding; recreate the memory schema before starting the memory store',
    );
  }
}

export async function validatePostgresMemorySchema(pool: Pool): Promise<void> {
  const legacyEmbeddingTables = await queryRows<MemorySchemaTableRow>(pool, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memory_embeddings'
  `);
  if (legacyEmbeddingTables.length > 0) {
    throw new Error(
      'Unsupported PostgreSQL memory schema detected: l2_memory_embeddings is no longer used; recreate the memory schema so embeddings live on l2_memories.embedding',
    );
  }

  const memoryColumns = await queryRows<MemorySchemaColumnRow>(pool, `
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memories'
  `);
  const embeddingColumn = memoryColumns.find(column => column.column_name === 'embedding');
  if (!embeddingColumn) {
    throw new Error(
      'PostgreSQL memory schema is missing l2_memories.embedding; recreate the memory schema before starting the memory store',
    );
  }
  if (embeddingColumn.udt_name !== 'vector') {
    throw new Error(
      `PostgreSQL memory schema column l2_memories.embedding must use pgvector, got ${embeddingColumn.udt_name || embeddingColumn.data_type}`,
    );
  }
}
