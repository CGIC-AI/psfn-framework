import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

export interface FilesystemIdentity {
  device: string;
  inode: string;
}

export interface PinnedDirectory {
  descriptor: number;
  identity: FilesystemIdentity;
  logicalPath: string;
}

export interface InspectedPinnedFile extends FilesystemIdentity {
  bytes: number;
  sha256: string;
}

export interface ReadPinnedFile extends InspectedPinnedFile {
  content: Buffer;
}

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function procDescriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

export function filesystemIdentityForDescriptor(descriptor: number): FilesystemIdentity {
  const stats = fstatSync(descriptor, { bigint: true });
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function validateComponent(component: string, label: string): void {
  if (!component || component === '.' || component === '..' || component.includes(sep)) {
    throw new Error(`${label} contains an invalid path component`);
  }
}

function openChildDirectory(
  parentDescriptor: number,
  component: string,
  logicalPath: string,
  label: string,
  create: boolean,
  exclusiveCreate: boolean,
  mode: number,
): number | undefined {
  validateComponent(component, label);
  const operationPath = `${procDescriptorPath(parentDescriptor)}/${component}`;
  if (create) {
    try {
      mkdirSync(operationPath, { mode });
      fsyncSync(parentDescriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || exclusiveCreate) throw error;
    }
  }
  try {
    const descriptor = openSync(operationPath, DIRECTORY_OPEN_FLAGS);
    if (!fstatSync(descriptor).isDirectory()) {
      closeSync(descriptor);
      throw new Error(`${label} must be a directory without symlinks: ${logicalPath}`);
    }
    return descriptor;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!create && code === 'ENOENT') return undefined;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new Error(`${label} must be a directory without symlinks: ${logicalPath}`);
    }
    throw error;
  }
}

export function pinAbsoluteDirectory(path: string, label: string): PinnedDirectory {
  const logicalPath = resolve(path);
  let descriptor = openSync('/', DIRECTORY_OPEN_FLAGS);
  let traversed = '/';
  try {
    for (const component of logicalPath.split(sep).filter(Boolean)) {
      traversed = resolve(traversed, component);
      const child = openChildDirectory(
        descriptor,
        component,
        traversed,
        label,
        false,
        false,
        0o700,
      );
      if (child === undefined) throw new Error(`${label} does not exist: ${traversed}`);
      closeSync(descriptor);
      descriptor = child;
    }
    return { descriptor, identity: filesystemIdentityForDescriptor(descriptor), logicalPath };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function relativeDirectoryPath(root: PinnedDirectory, target: string, label: string): string {
  const relativePath = relative(root.logicalPath, resolve(target));
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be a strict descendant of ${root.logicalPath}: ${target}`);
  }
  return relativePath;
}

export function pinRelativeDirectory(
  root: PinnedDirectory,
  relativePath: string,
  label: string,
  options: {
    allowMissing?: boolean;
    create?: boolean;
    exclusiveLeafCreate?: boolean;
    mode?: number;
  } = {},
): PinnedDirectory | undefined {
  if (!relativePath || relativePath.startsWith(sep)) {
    throw new Error(`${label} requires a non-empty relative path`);
  }
  const components = relativePath.split(sep);
  let descriptor = root.descriptor;
  let ownsDescriptor = false;
  let traversed = root.logicalPath;
  try {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      validateComponent(component, label);
      traversed = resolve(traversed, component);
      const child = openChildDirectory(
        descriptor,
        component,
        traversed,
        label,
        options.create === true,
        options.exclusiveLeafCreate === true && index === components.length - 1,
        options.mode ?? 0o700,
      );
      if (child === undefined) {
        if (options.allowMissing) {
          if (ownsDescriptor) closeSync(descriptor);
          return undefined;
        }
        throw new Error(`${label} does not exist: ${traversed}`);
      }
      if (ownsDescriptor) closeSync(descriptor);
      descriptor = child;
      ownsDescriptor = true;
    }
    return {
      descriptor,
      identity: filesystemIdentityForDescriptor(descriptor),
      logicalPath: resolve(root.logicalPath, relativePath),
    };
  } catch (error) {
    if (ownsDescriptor) closeSync(descriptor);
    throw error;
  }
}

export function pinnedLeafPath(directory: PinnedDirectory, leaf: string): string {
  validateComponent(leaf, 'Pinned filesystem operation');
  return `${procDescriptorPath(directory.descriptor)}/${leaf}`;
}

export function pinnedLeafExists(directory: PinnedDirectory, leaf: string): boolean {
  try {
    lstatSync(pinnedLeafPath(directory, leaf));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function listPinnedDirectoryNames(directory: PinnedDirectory): string[] {
  return readdirSync(`/proc/self/fd/${directory.descriptor}`).sort();
}

export function inspectPinnedRegularFile(
  directory: PinnedDirectory,
  leaf: string,
  label: string,
  options: { fsync?: boolean } = {},
): InspectedPinnedFile {
  const inspected = readPinnedRegularFile(directory, leaf, label, options);
  return {
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    device: inspected.device,
    inode: inspected.inode,
  };
}

export function readPinnedRegularFile(
  directory: PinnedDirectory,
  leaf: string,
  label: string,
  options: { fsync?: boolean } = {},
): ReadPinnedFile {
  const operationPath = pinnedLeafPath(directory, leaf);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(operationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular file without symlinks: ${resolve(directory.logicalPath, leaf)}`);
    }
    if (options.fsync) fsyncSync(descriptor);
    const content = readFileSync(descriptor);
    return {
      bytes: Number(stats.size),
      sha256: createHash('sha256').update(content).digest('hex'),
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file without symlinks: ${resolve(directory.logicalPath, leaf)}`);
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function assertPinnedDirectoryAtLogicalPath(
  directory: PinnedDirectory,
  label: string,
): void {
  let current: PinnedDirectory | undefined;
  try {
    current = pinAbsoluteDirectory(directory.logicalPath, label);
    assertFilesystemIdentity(current.identity, directory.identity, label);
  } finally {
    closePinnedDirectory(current);
  }
}

export function assertFilesystemIdentity(
  actual: FilesystemIdentity,
  expected: FilesystemIdentity,
  label: string,
): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label} changed identity; refusing pathname-based recovery`);
  }
}

export function closePinnedDirectory(directory: PinnedDirectory | undefined): void {
  if (directory) closeSync(directory.descriptor);
}
