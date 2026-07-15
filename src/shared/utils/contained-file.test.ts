import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeContainedFileSync } from './contained-file.js';

describe('materializeContainedFileSync', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects a path swapped to an outside symlink immediately before open', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-contained-file-'));
    roots.push(root);
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    mkdirSync(allowed);
    mkdirSync(outside);
    const candidate = join(allowed, 'image.png');
    const secret = join(outside, 'secret.png');
    writeFileSync(candidate, 'safe');
    writeFileSync(secret, 'peer-secret');

    expect(() => materializeContainedFileSync({
      path: candidate,
      root: allowed,
      readMaxBytes: 1_000,
      beforeOpen: () => {
        unlinkSync(candidate);
        symlinkSync(secret, candidate);
      },
    })).toThrow();
  });

  it('returns immutable bytes read from the validated descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-contained-file-'));
    roots.push(root);
    const allowed = join(root, 'allowed');
    mkdirSync(allowed);
    const candidate = join(allowed, 'image.png');
    writeFileSync(candidate, 'safe-bytes');

    const result = materializeContainedFileSync({
      path: candidate,
      root: allowed,
      readMaxBytes: 1_000,
    });
    writeFileSync(candidate, 'changed-later');

    expect(result.bytes?.toString('utf8')).toBe('safe-bytes');
  });
});
