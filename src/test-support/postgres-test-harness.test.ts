import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  PGVECTOR_POSTGRES_TEST_IMAGE,
  postgresTestContainerNameForImage,
  postgresTestDockerRunArgs,
  resolveMaxConcurrentHarnesses,
  resolvePostgresTestTmpfsSize,
  shouldStopContainerBetweenFiles,
} from './postgres-test-harness.js';

describe('RAM-backed Postgres test containers', () => {
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

  it('uses a stable default runtime profile across test processes', () => {
    expect(postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE)).toBe(
      postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE),
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

  it('forces disposable PostgreSQL data into bounded RAM without swap or Docker logs', () => {
    const name = postgresTestContainerNameForImage(DEFAULT_POSTGRES_TEST_IMAGE, 'slot-0');
    const args = postgresTestDockerRunArgs(DEFAULT_POSTGRES_TEST_IMAGE, name);
    const valueAfter = (option: string): string | undefined => {
      const index = args.indexOf(option);
      return index < 0 ? undefined : args[index + 1];
    };

    expect(valueAfter('--tmpfs')).toBe(
      '/var/lib/postgresql/data:rw,noexec,nosuid,size=1g',
    );
    expect(valueAfter('--memory')).toBe('1g');
    // Swap is pinned to the memory limit so the container can never spill the
    // RAM-backed cluster onto disk.
    expect(valueAfter('--memory-swap')).toBe('1g');
    expect(valueAfter('--cpus')).toBe('2');
    expect(valueAfter('--shm-size')).toBe('128m');
    expect(valueAfter('--log-driver')).toBe('none');
    // Bumped with the tmpfs/memory raise: the profile is part of the container
    // name and the reuse check, so warm containers built on the old shape are
    // rotated out instead of silently reused at the old size.
    expect(args).toContain('io.local-gate.test-postgres.profile=tmpfs-v2');
    expect(args).toContain('POSTGRES_INITDB_ARGS=--nosync');

    const imageIndex = args.lastIndexOf(DEFAULT_POSTGRES_TEST_IMAGE);
    expect(args.slice(imageIndex)).toEqual([
      DEFAULT_POSTGRES_TEST_IMAGE,
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'min_wal_size=32MB',
      '-c',
      'max_wal_size=64MB',
    ]);
  });

  // Stopping wipes the tmpfs PGDATA, so every restart pays a full initdb.
  // Keeping the server hot between files is the whole point of the RAM profile.
  it('keeps the container hot between test files by default', () => {
    expect(shouldStopContainerBetweenFiles({})).toBe(false);
  });

  it('restores stop-between-files only on the explicit opt-in value', () => {
    expect(
      shouldStopContainerBetweenFiles({ PSFN_POSTGRES_TEST_STOP_BETWEEN_FILES: '1' }),
    ).toBe(true);
    for (const value of ['0', 'true', 'yes', '']) {
      expect(
        shouldStopContainerBetweenFiles({ PSFN_POSTGRES_TEST_STOP_BETWEEN_FILES: value }),
      ).toBe(false);
    }
  });

  // Too few slots turns ordinary queueing into beforeAll hook timeouts on
  // whichever integration files land at the back of the semaphore.
  it('scales harness slots with the machine, within a bounded range', () => {
    expect(resolveMaxConcurrentHarnesses({}, 32)).toBe(8);
    expect(resolveMaxConcurrentHarnesses({}, 64)).toBe(8);
    expect(resolveMaxConcurrentHarnesses({}, 16)).toBe(4);
    expect(resolveMaxConcurrentHarnesses({}, 4)).toBe(4);
    expect(resolveMaxConcurrentHarnesses({}, 1)).toBe(4);
  });

  it('honours an explicit slot override and rejects unusable values', () => {
    expect(resolveMaxConcurrentHarnesses({ PSFN_POSTGRES_TEST_MAX_HARNESSES: '2' }, 32)).toBe(2);
    expect(resolveMaxConcurrentHarnesses({ PSFN_POSTGRES_TEST_MAX_HARNESSES: '16' }, 4)).toBe(16);
    for (const value of ['0', '-1', '2.5', 'many']) {
      expect(() =>
        resolveMaxConcurrentHarnesses({ PSFN_POSTGRES_TEST_MAX_HARNESSES: value }, 32),
      ).toThrow(/positive integer/);
    }
  });

  // Databases accumulate for the whole of a file, so a database-heavy file is
  // sized by its test count. 512m ran out partway through the memory-store
  // integration file and failed whichever test happened to be last.
  it('defaults the tmpfs to enough headroom for a database-heavy file', () => {
    expect(resolvePostgresTestTmpfsSize({})).toBe('1g');
    expect(resolvePostgresTestTmpfsSize({ PSFN_POSTGRES_TEST_TMPFS_SIZE: '   ' })).toBe('1g');
  });

  it('honours an explicit tmpfs override and rejects unusable sizes', () => {
    for (const value of ['512m', '2g', '1500M', '262144k']) {
      expect(resolvePostgresTestTmpfsSize({ PSFN_POSTGRES_TEST_TMPFS_SIZE: value })).toBe(value);
    }
    // A unitless or garbage value would be silently rejected by Docker at
    // container-create time, stranding the run behind a confusing failure.
    for (const value of ['1024', '1gb', '1.5g', 'large', '-1g']) {
      expect(() =>
        resolvePostgresTestTmpfsSize({ PSFN_POSTGRES_TEST_TMPFS_SIZE: value }),
      ).toThrow(/Docker size/);
    }
  });
});
