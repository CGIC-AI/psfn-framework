import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  PGVECTOR_POSTGRES_TEST_IMAGE,
  postgresTestContainerScope,
  postgresTestContainerNameForImage,
} from './postgres-test-harness.js';

describe('persistent Postgres test container identity', () => {
  it('is stable for one exact image and safe as a Docker name', () => {
    const name = postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'vitest-pool-1');

    expect(postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'vitest-pool-1')).toBe(
      name,
    );
    expect(name).toMatch(/^local-gate-test-postgres-[a-f0-9]{8}-[a-f0-9]{16}$/);
  });

  it('keeps images and parallel worker pools in separate containers', () => {
    expect(postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'vitest-pool-1')).not.toBe(
      postgresTestContainerNameForImage(PGVECTOR_POSTGRES_TEST_IMAGE, 'vitest-pool-1'),
    );
    expect(postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'vitest-pool-1')).not.toBe(
      postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'vitest-pool-2'),
    );
  });

  it('keeps simultaneous Vitest invocations separate even when pool IDs match', () => {
    const firstRun = postgresTestContainerScope({
      vitestPoolId: '1',
      invocationProcessId: 101,
    });
    const secondRun = postgresTestContainerScope({
      vitestPoolId: '1',
      invocationProcessId: 202,
    });

    expect(firstRun).toBe('vitest-run-101-pool-1');
    expect(secondRun).toBe('vitest-run-202-pool-1');
    expect(postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, firstRun)).not.toBe(
      postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, secondRun),
    );
  });

  it('rejects empty identity inputs instead of sharing an ambiguous container', () => {
    expect(() => postgresTestContainerNameForImage('   ', 'vitest-pool-1')).toThrow(
      /image must not be empty/,
    );
    expect(() => postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, '   ')).toThrow(
      /scope must not be empty/,
    );
  });
});
