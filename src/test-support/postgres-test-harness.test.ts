import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  PGVECTOR_POSTGRES_TEST_IMAGE,
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

  it('rejects empty identity inputs instead of sharing an ambiguous container', () => {
    expect(() => postgresTestContainerNameForImage('   ', 'vitest-pool-1')).toThrow(
      /image must not be empty/,
    );
    expect(() => postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, '   ')).toThrow(
      /scope must not be empty/,
    );
  });
});
