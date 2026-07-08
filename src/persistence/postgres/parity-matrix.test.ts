import { describe, expect, it } from 'vitest';
import {
  getPostgresParityEntry,
  listPostgresParityGaps,
  POSTGRES_NO_LOSS_VALIDATION_CONTRACT,
  POSTGRES_PARITY_MATRIX,
  POSTGRES_PARITY_MIGRATION_ONLY_SQLITE_READER_EXCEPTION,
  POSTGRES_PARITY_REQUIRED_CUTOVER_GAPS,
  POSTGRES_PARITY_SURFACE_IDS,
  type PostgresParityEntry,
  type PostgresParitySurfaceId,
} from './parity-matrix.js';

function requireEntry(id: PostgresParitySurfaceId): PostgresParityEntry {
  return getPostgresParityEntry(id);
}

describe('Postgres parity matrix', () => {
  it('covers each required SQLite/Postgres parity surface exactly once', () => {
    const ids = POSTGRES_PARITY_MATRIX.map(entry => entry.id);

    expect(ids).toHaveLength(POSTGRES_PARITY_SURFACE_IDS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...POSTGRES_PARITY_SURFACE_IDS].sort());
  });

  it('keeps the required no-loss validation contract code-facing', () => {
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.countParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.checksumParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.semanticParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.failClosed.length).toBeGreaterThanOrEqual(3);
  });

  it('requires count, checksum, and semantic validation for every matrix entry', () => {
    for (const entry of POSTGRES_PARITY_MATRIX) {
      expect(entry.validation.countParity.length, `${entry.id} countParity`).toBeGreaterThan(0);
      expect(entry.validation.checksumParity.length, `${entry.id} checksumParity`).toBeGreaterThan(0);
      expect(entry.validation.semanticParity.length, `${entry.id} semanticParity`).toBeGreaterThan(0);
      expect(entry.noLossContract.length, `${entry.id} noLossContract`).toBeGreaterThan(0);
      expect(entry.codeReferences.length, `${entry.id} codeReferences`).toBeGreaterThan(0);
    }
  });

  it('captures the known schema and runtime gaps as non-covered entries', () => {
    for (const id of POSTGRES_PARITY_REQUIRED_CUTOVER_GAPS) {
      const entry = requireEntry(id);
      expect(entry.status, `${id} should not be marked covered`).not.toBe('covered');
      expect(entry.gaps.length, `${id} gaps`).toBeGreaterThan(0);
    }

    expect(requireEntry('l01-episodic-store').gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('l01_episodes'),
      expect.stringContaining('l01_episode_arcs'),
    ]));
    expect(requireEntry('l2-memory-patch-provenance').gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('source_type'),
      expect.stringContaining('l2_memory_patch_events'),
      expect.stringContaining('recordPatchEvent'),
    ]));
    expect(requireEntry('migration-audit-ledger').postgresDestinationArtifacts).toEqual(expect.arrayContaining([
      expect.stringContaining('postgres_migration_runs'),
      expect.stringContaining('postgres_migration_table_checks'),
    ]));
  });

  it('separates filesystem truth from database projections', () => {
    const l0Archive = requireEntry('l0-session-archive');
    const sessionProjection = requireEntry('session-search-projection');

    expect(l0Archive.status).toBe('filesystem_truth');
    expect(l0Archive.postgresDestinationArtifacts).toEqual(expect.arrayContaining([
      expect.stringContaining('No Postgres source-of-truth table'),
    ]));
    expect(sessionProjection.status).toBe('covered');
    expect(sessionProjection.postgresDestinationArtifacts).toEqual(expect.arrayContaining([
      expect.stringContaining('session_messages_projection'),
    ]));
  });

  it('defines the only allowed SQLite reader as a migration-only exception', () => {
    const exceptionEntry = requireEntry('migration-only-sqlite-reader');

    expect(exceptionEntry.status).toBe('migration_only_exception');
    expect(exceptionEntry.cutoverAction).toBe('keep_migration_only_reader');
    expect(POSTGRES_PARITY_MIGRATION_ONLY_SQLITE_READER_EXCEPTION.disallowedRuntimeSurfaces).toEqual(
      expect.arrayContaining([
        'src/app/gateway/main.ts',
        'src/app/agent/main.ts',
        'src/operator/garden/**',
      ]),
    );
    expect(POSTGRES_PARITY_MIGRATION_ONLY_SQLITE_READER_EXCEPTION.requiredGuards.length).toBeGreaterThanOrEqual(4);
  });

  it('lists only entries with explicit gaps from the gap helper', () => {
    const gaps = listPostgresParityGaps();

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every(entry => entry.gaps.length > 0)).toBe(true);
    expect(gaps.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'l01-episodic-store',
      'l2-memory-patch-provenance',
      'config-defaults',
    ]));
  });
});
