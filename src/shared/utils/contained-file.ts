import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface MaterializedContainedFile {
  canonicalPath: string;
  sizeBytes: number;
  bytes: Buffer | null;
}

export interface MaterializeContainedFileOptions {
  path: string;
  root: string;
  /** Files above this size are validated but not read into memory. */
  readMaxBytes: number;
  /** Deterministic race seam used by regression tests. */
  beforeOpen?: () => void;
}

function isStrictSubpath(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return Boolean(pathFromRoot)
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(pathFromRoot);
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

/**
 * Opens first, then validates the actual opened descriptor through `/proc` and
 * reads that same descriptor. `O_NOFOLLOW` rejects a final-component symlink;
 * descriptor canonicalization also catches parent-directory swaps.
 */
export function materializeContainedFileSync(
  options: MaterializeContainedFileOptions,
): MaterializedContainedFile {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new Error('Contained file materialization requires O_NOFOLLOW support');
  }
  const requestedPath = resolve(options.path);
  const canonicalRoot = realpathSync(resolve(options.root));
  options.beforeOpen?.();

  const descriptor = openSync(requestedPath, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('Contained file source must be a regular file');
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    const canonicalPath = realpathSync(descriptorPath);
    if (!isStrictSubpath(canonicalPath, canonicalRoot)) {
      throw new Error('Contained file source resolves outside its authenticated root');
    }
    const bytes = before.size <= options.readMaxBytes ? readFileSync(descriptor) : null;
    const after = fstatSync(descriptor);
    if (!sameFile(before, after)) {
      throw new Error('Contained file source changed while it was being materialized');
    }
    return { canonicalPath, sizeBytes: before.size, bytes };
  } finally {
    closeSync(descriptor);
  }
}
