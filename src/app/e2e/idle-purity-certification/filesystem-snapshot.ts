import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

interface DurableFileEntry {
  readonly fingerprint: string;
  readonly kind: 'directory' | 'file' | 'other' | 'symlink';
}

export type DurableFileSnapshot = ReadonlyMap<string, DurableFileEntry>;

function relativeSnapshotPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

async function fingerprintEntry(path: string): Promise<DurableFileEntry> {
  const stat = await lstat(path, { bigint: true });
  const common = `${stat.mode.toString()}:${stat.mtimeNs.toString()}:${stat.ctimeNs.toString()}`;
  if (stat.isDirectory()) {
    return { kind: 'directory', fingerprint: common };
  }
  if (stat.isFile()) {
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    return {
      kind: 'file',
      fingerprint: `${common}:${stat.size.toString()}:${digest}`,
    };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', fingerprint: `${common}:${await readlink(path)}` };
  }
  return { kind: 'other', fingerprint: `${common}:${stat.size.toString()}` };
}

export async function captureDurableFileSnapshot(root: string): Promise<DurableFileSnapshot> {
  const snapshot = new Map<string, DurableFileEntry>();
  snapshot.set('.', await fingerprintEntry(root));

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const captured = await fingerprintEntry(path);
      snapshot.set(relativeSnapshotPath(root, path), captured);
      if (captured.kind === 'directory') await walk(path);
    }
  };

  await walk(root);
  return snapshot;
}
