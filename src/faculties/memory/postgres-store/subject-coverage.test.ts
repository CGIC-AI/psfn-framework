import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  inspectMemorySubjectClassificationCoverage,
} from './subject-coverage.js';

describe('inspectMemorySubjectClassificationCoverage', () => {
  it('reports the exact missing-current count from the startup aggregate', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        total_memory_count: '12',
        current_classification_count: '9',
      }],
      rowCount: 1,
    }));

    await expect(inspectMemorySubjectClassificationCoverage(
      { query } as unknown as Pool,
      4_000,
    )).resolves.toEqual({
      checkedAt: 4_000,
      totalMemoryCount: 12,
      currentClassificationCount: 9,
      missingCurrentClassificationCount: 3,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('fails closed on an impossible or missing aggregate', async () => {
    await expect(inspectMemorySubjectClassificationCoverage({
      query: vi.fn(async () => ({
        rows: [{
          total_memory_count: '2',
          current_classification_count: '3',
        }],
        rowCount: 1,
      })),
    } as unknown as Pool)).rejects.toThrow(/internally inconsistent/u);

    await expect(inspectMemorySubjectClassificationCoverage({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as Pool)).rejects.toThrow(/returned no aggregate row/u);
  });
});
