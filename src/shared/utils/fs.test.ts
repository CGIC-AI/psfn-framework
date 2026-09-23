import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileDurableAtomicSync, writeJsonAtomic } from './fs.js';

let root: string | null = null;
let previousUmask: number | null = null;

afterEach(() => {
  if (previousUmask !== null) process.umask(previousUmask);
  previousUmask = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function restrictiveUmask(): string {
  root = mkdtempSync(join(tmpdir(), 'durable-write-mode-'));
  // A restrictive operator/CI umask must not narrow a canonical owner mode.
  previousUmask = process.umask(0o027);
  return root;
}

describe('explicit file modes survive a restrictive umask', () => {
  it('publishes writeFileDurableAtomicSync output with the exact requested mode', () => {
    const path = join(restrictiveUmask(), 'owner.json');
    writeFileDurableAtomicSync(path, '{}\n', { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('publishes writeJsonAtomic output with the exact requested mode', () => {
    const path = join(restrictiveUmask(), 'owner.json');
    writeJsonAtomic(path, {}, { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
