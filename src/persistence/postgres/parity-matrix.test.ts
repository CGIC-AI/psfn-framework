import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getPostgresParityEntry,
  listPostgresParityGaps,
  POSTGRES_NO_LOSS_VALIDATION_CONTRACT,
  POSTGRES_PARITY_MATRIX,
  POSTGRES_PARITY_MATRIX_VERSION,
  POSTGRES_PARITY_REQUIRED_GAPS,
  POSTGRES_PARITY_SURFACE_IDS,
  type PostgresParityEntry,
  type PostgresParitySurfaceId,
} from './parity-matrix.js';

function requireEntry(id: PostgresParitySurfaceId): PostgresParityEntry {
  return getPostgresParityEntry(id);
}

describe('Postgres parity matrix', () => {
  it('covers each required operational persistence surface exactly once', () => {
    const ids = POSTGRES_PARITY_MATRIX.map(entry => entry.id);

    expect(POSTGRES_PARITY_MATRIX_VERSION).toBe(2);
    expect(ids).toHaveLength(POSTGRES_PARITY_SURFACE_IDS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...POSTGRES_PARITY_SURFACE_IDS].sort());
  });

  it('keeps the no-loss validation contract code-facing', () => {
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.countParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.checksumParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.semanticParity.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_NO_LOSS_VALIDATION_CONTRACT.failClosed.length).toBeGreaterThanOrEqual(4);
  });

  it('requires count, checksum, semantic, and integrity validation for every entry', () => {
    for (const entry of POSTGRES_PARITY_MATRIX) {
      expect(entry.validation.countParity.length, `${entry.id} countParity`).toBeGreaterThan(0);
      expect(entry.validation.checksumParity.length, `${entry.id} checksumParity`).toBeGreaterThan(0);
      expect(entry.validation.semanticParity.length, `${entry.id} semanticParity`).toBeGreaterThan(0);
      expect(entry.integrityContract.length, `${entry.id} integrityContract`).toBeGreaterThan(0);
      expect(entry.sourceOfTruthArtifacts.length, `${entry.id} sourceOfTruthArtifacts`).toBeGreaterThan(0);
      expect(entry.postgresArtifacts.length, `${entry.id} postgresArtifacts`).toBeGreaterThan(0);
    }
  });

  it('contains only live code references', () => {
    for (const entry of POSTGRES_PARITY_MATRIX) {
      for (const codeReference of entry.codeReferences) {
        expect(existsSync(codeReference), `${entry.id} references missing ${codeReference}`).toBe(true);
      }
    }
  });

  it('contains no retired-backend exception, status, action, or implementation reference', () => {
    const serialized = JSON.stringify(POSTGRES_PARITY_MATRIX).toLowerCase();

    expect(serialized).not.toMatch(/sqlite|better-sqlite|sqlite-vec/u);
    for (const entry of POSTGRES_PARITY_MATRIX) {
      expect(entry).not.toHaveProperty('cutoverAction');
      expect(entry).not.toHaveProperty('sqliteSourceArtifacts');
    }
  });

  it('separates filesystem truth from the Postgres search projection', () => {
    const l0Archive = requireEntry('l0-session-archive');
    const sessionProjection = requireEntry('session-search-projection');

    expect(l0Archive.status).toBe('filesystem_truth');
    expect(l0Archive.ownership).toBe('filesystem_truth');
    expect(sessionProjection.status).toBe('covered');
    expect(sessionProjection.ownership).toBe('postgres_projection');
    expect(sessionProjection.postgresArtifacts).toContain('session_messages_projection');
  });

  it('records only current operational gaps', () => {
    const gaps = listPostgresParityGaps();

    expect(gaps.map(entry => entry.id)).toEqual([...POSTGRES_PARITY_REQUIRED_GAPS]);
    expect(gaps.every(entry => entry.status === 'partial' || entry.status === 'missing')).toBe(true);
    expect(requireEntry('intention-care-reminders').gaps).toEqual([
      'No Postgres care-reminder schema or adapter is wired into the runtime.',
    ]);
    expect(requireEntry('backup-service').gaps[0]).toContain('domain retrieval queries');
  });
});
