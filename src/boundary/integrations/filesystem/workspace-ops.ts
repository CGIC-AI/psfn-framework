import { glob as fsGlob, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
} from '../../gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemListOptions,
  FilesystemListResult,
  FilesystemReadResult,
  FilesystemSearchMatch,
  FilesystemSearchMode,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';

const DEFAULT_LIST_GLOB = '**/*';
const DEFAULT_DIRECTORY_LIST_GLOB = '*';
export const DEFAULT_LIST_MAX_ENTRIES = 200;
export const MAX_LIST_MAX_ENTRIES = 500;
export const DEFAULT_LIST_MAX_SCANNED_ENTRIES = 5_000;
export const MAX_LIST_MAX_SCANNED_ENTRIES = 20_000;
const DEFAULT_SEARCH_MODE: FilesystemSearchMode = 'literal';
const DEFAULT_SEARCH_MAX_MATCHES = 50;
const MAX_SEARCH_MAX_MATCHES = 200;
const DEFAULT_SEARCH_MAX_FILES = 200;
const MAX_SEARCH_MAX_FILES = 500;
const DEFAULT_SEARCH_MAX_BYTES_PER_FILE = 40_000;
const MAX_SEARCH_MAX_BYTES_PER_FILE = 200_000;
const DEFAULT_SEARCH_CONTEXT_LINES = 0;
const MAX_SEARCH_CONTEXT_LINES = 2;
const MAX_PREVIEW_CHARS = 500;
const SEARCHABLE_TEXT_EXTENSIONS = [
  'md',
  'mdx',
  'txt',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
] as const;
const DEFAULT_SEARCH_FOLDERS = [
  'downloads',
  'docs',
  'knowledge',
  'journal',
  'scratchpad',
  'skills',
  'modules',
  'experiments',
] as const;

class ListScanLimitReachedError extends Error {
  constructor() {
    super('fs list scan limit reached');
  }
}

interface GlobDirentLike {
  name: string;
  path?: string;
  parentPath?: string;
  isDirectory(): boolean;
}

export interface FilesystemListLimits {
  maxEntries: number;
  maxScannedEntries: number;
}

export interface BoundedGlobListOptions extends FilesystemListLimits {
  cwd: string;
  glob: string;
  allowedRoots: string[];
  toDisplayPath(absolutePath: string): string;
}

function clampFiniteInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizeListLimits(
  maxEntries: unknown,
  maxScannedEntries: unknown,
): FilesystemListLimits {
  return {
    maxEntries: clampFiniteInteger(maxEntries, DEFAULT_LIST_MAX_ENTRIES, 1, MAX_LIST_MAX_ENTRIES),
    maxScannedEntries: clampFiniteInteger(
      maxScannedEntries,
      DEFAULT_LIST_MAX_SCANNED_ENTRIES,
      1,
      MAX_LIST_MAX_SCANNED_ENTRIES,
    ),
  };
}

function isGlobDirentLike(value: unknown): value is GlobDirentLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'isDirectory' in value
    && typeof (value as { isDirectory?: unknown }).isDirectory === 'function';
}

function isGlobDirectory(value: unknown): boolean {
  return isGlobDirentLike(value) && value.isDirectory();
}

function resolveGlobMatchPath(match: unknown, cwd: string): string {
  if (isGlobDirentLike(match)) {
    const parentPath = typeof match.parentPath === 'string'
      ? match.parentPath
      : typeof match.path === 'string'
        ? match.path
        : cwd;
    return join(parentPath, match.name);
  }
  return resolveWorkspaceFsPathFromRoot(String(match), cwd);
}

function workspaceRelativePath(absolutePath: string, root: string): string {
  return relative(root, absolutePath).replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchMode(value: unknown): FilesystemSearchMode {
  return value === 'regex' ? 'regex' : DEFAULT_SEARCH_MODE;
}

export function isBroadSearchGlob(value: string | undefined): boolean {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    : '';
  return normalized.length === 0 || normalized === '**' || normalized === '**/*';
}

export function buildWorkingFolderSearchGlob(prefix = ''): string {
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const textExtensionGlob = `{${SEARCHABLE_TEXT_EXTENSIONS.join(',')}}`;
  const folderGlob = `{${DEFAULT_SEARCH_FOLDERS.join(',')}}`;
  const workingPattern = `{*.${textExtensionGlob},${folderGlob}/*.${textExtensionGlob},${folderGlob}/*/*.${textExtensionGlob},${folderGlob}/*/*/*.${textExtensionGlob}}`;
  return normalizedPrefix.length > 0 ? `${normalizedPrefix}/${workingPattern}` : workingPattern;
}

function normalizeListPath(value: string | undefined): string {
  const normalizedPath = normalizeWorkspaceRelativeGlob(value);
  if (normalizedPath === null) {
    throw new Error('fs list path must be a workspace-relative directory path');
  }
  return normalizedPath === '**/*' ? '' : normalizedPath.replace(/\/\*$/, '').replace(/\/+$/, '');
}

function normalizeListGlob(glob: string | undefined): string {
  const normalizedGlob = normalizeWorkspaceRelativeGlob(
    isBroadSearchGlob(glob) ? DEFAULT_DIRECTORY_LIST_GLOB : glob,
  );
  if (!normalizedGlob) {
    throw new Error('fs list glob must be a non-empty workspace-relative pattern');
  }
  return normalizedGlob;
}

function buildListGlob(glob: string | undefined, options?: FilesystemListOptions): string {
  const basePath = typeof options?.path === 'string' && options.path.trim().length > 0
    ? normalizeListPath(options.path)
    : '';
  const normalizedGlob = normalizeListGlob(glob);
  return basePath.length > 0 ? `${basePath}/${normalizedGlob}` : normalizedGlob;
}

function normalizeWorkspacePath(path: string, root: string, action: 'read' | 'write' | 'edit'): string {
  const resolvedPath = resolveWorkspaceFsPathFromRoot(path, root);
  if (!isInsideAllowedPaths(resolvedPath, [root])) {
    throw new Error(`fs ${action} path must stay inside the workspace root`);
  }
  return resolvedPath;
}

function normalizeSearchPreview(lines: string[], lineIndex: number, contextLines: number): string {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length - 1, lineIndex + contextLines);
  const preview = lines.slice(start, end + 1).join('\n');
  if (preview.length <= MAX_PREVIEW_CHARS) {
    return preview;
  }
  return `${preview.slice(0, MAX_PREVIEW_CHARS)}\n... (truncated)`;
}

function collectLineMatches(
  path: string,
  content: string,
  query: string,
  mode: FilesystemSearchMode,
  contextLines: number,
  remainingMatches: number,
): FilesystemSearchMatch[] {
  const lines = content.split('\n');
  const matches: FilesystemSearchMatch[] = [];
  const regex = mode === 'regex'
    ? new RegExp(query, 'g')
    : new RegExp(escapeRegExp(query), 'g');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    regex.lastIndex = 0;
    const line = lines[lineIndex] ?? '';
    let match: RegExpExecArray | null = regex.exec(line);
    while (match) {
      matches.push({
        path,
        line: lineIndex + 1,
        column: match.index + 1,
        preview: normalizeSearchPreview(lines, lineIndex, contextLines),
      });
      if (matches.length >= remainingMatches) {
        return matches;
      }
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
      match = regex.exec(line);
    }
  }

  return matches;
}

export async function readTextFile(path: string, maxBytes?: number): Promise<FilesystemReadResult> {
  const boundedMaxBytes = clampFiniteInteger(maxBytes, 0, 0, MAX_SEARCH_MAX_BYTES_PER_FILE);
  if (boundedMaxBytes <= 0) {
    return {
      content: await readFile(path, 'utf-8'),
      truncated: false,
    };
  }

  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(boundedMaxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, boundedMaxBytes)).toString('utf-8'),
      truncated: bytesRead > boundedMaxBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function listWorkspaceFiles(
  root: string,
  glob = DEFAULT_LIST_GLOB,
  maxEntries = DEFAULT_LIST_MAX_ENTRIES,
  options?: FilesystemListOptions,
): Promise<FilesystemListResult> {
  const normalizedGlob = buildListGlob(glob, options);
  const limits = normalizeListLimits(maxEntries, options?.maxScannedEntries);

  return collectBoundedGlobFiles({
    cwd: root,
    glob: normalizedGlob,
    allowedRoots: [root],
    ...limits,
    toDisplayPath: absolutePath => workspaceRelativePath(absolutePath, root),
  });
}

export async function collectBoundedGlobFiles(options: BoundedGlobListOptions): Promise<FilesystemListResult> {
  const paths: string[] = [];
  let scannedEntries = 0;
  let entryLimitReached = false;
  let scanLimitReached = false;

  const exclude = (): boolean => {
    if (scannedEntries >= options.maxScannedEntries) {
      scanLimitReached = true;
      throw new ListScanLimitReachedError();
    }
    scannedEntries += 1;
    return false;
  };

  try {
    for await (const match of fsGlob(options.glob, {
      cwd: options.cwd,
      withFileTypes: true,
      exclude,
    })) {
      if (isGlobDirectory(match)) {
        continue;
      }
      const absolute = resolveGlobMatchPath(match, options.cwd);
      if (!isInsideAllowedPaths(absolute, options.allowedRoots)) {
        continue;
      }
      paths.push(options.toDisplayPath(absolute));
      if (paths.length >= options.maxEntries) {
        entryLimitReached = true;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ListScanLimitReachedError)) {
      throw error;
    }
  }

  paths.sort((left, right) => left.localeCompare(right));
  return {
    paths,
    scannedEntries,
    maxEntries: options.maxEntries,
    maxScannedEntries: options.maxScannedEntries,
    truncated: entryLimitReached || scanLimitReached,
    scanLimitReached,
    entryLimitReached,
  };
}

function normalizeSearchGlob(options: FilesystemSearchOptions): string {
  const normalizedGlob = normalizeWorkspaceRelativeGlob(
    isBroadSearchGlob(options.glob) ? buildWorkingFolderSearchGlob() : options.glob,
  );
  if (normalizedGlob === null) {
    throw new Error('fs search glob must be a non-empty workspace-relative pattern');
  }
  return normalizedGlob;
}

export async function searchWorkspaceFiles(root: string, options: FilesystemSearchOptions): Promise<FilesystemSearchResult> {
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  if (!query) {
    throw new Error('fs search query must be a non-empty string');
  }

  const mode = normalizeSearchMode(options.mode);
  if (mode === 'regex') {
    try {
      // Compile once so invalid patterns fail closed before scanning files.
      new RegExp(query, 'g');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`fs search regex is invalid: ${message}`);
    }
  }

  const normalizedGlob = normalizeSearchGlob(options);

  const maxMatches = clampFiniteInteger(options.maxMatches, DEFAULT_SEARCH_MAX_MATCHES, 1, MAX_SEARCH_MAX_MATCHES);
  const maxFiles = clampFiniteInteger(options.maxFiles, DEFAULT_SEARCH_MAX_FILES, 1, MAX_SEARCH_MAX_FILES);
  const maxBytesPerFile = clampFiniteInteger(
    options.maxBytesPerFile,
    DEFAULT_SEARCH_MAX_BYTES_PER_FILE,
    1,
    MAX_SEARCH_MAX_BYTES_PER_FILE,
  );
  const contextLines = clampFiniteInteger(
    options.contextLines,
    DEFAULT_SEARCH_CONTEXT_LINES,
    0,
    MAX_SEARCH_CONTEXT_LINES,
  );
  const listResult = await listWorkspaceFiles(root, normalizedGlob, maxFiles);
  const paths = listResult.paths;
  const matches: FilesystemSearchMatch[] = [];
  const truncatedFiles: string[] = [];
  let scannedFiles = 0;

  for (const path of paths) {
    const absolutePath = resolveWorkspaceFsPathFromRoot(path, root);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      continue;
    }
    const readResult = await readTextFile(absolutePath, maxBytesPerFile);
    scannedFiles += 1;
    if (readResult.truncated) {
      truncatedFiles.push(path);
    }
    if (readResult.content.includes('\0')) {
      continue;
    }

    const remainingMatches = maxMatches - matches.length;
    if (remainingMatches <= 0) {
      break;
    }

    const fileMatches = collectLineMatches(
      path,
      readResult.content,
      query,
      mode,
      contextLines,
      remainingMatches,
    );
    matches.push(...fileMatches);
    if (matches.length >= maxMatches) {
      break;
    }
  }

  return {
    query,
    glob: normalizedGlob,
    mode,
    scannedFiles,
    hitLimit: matches.length >= maxMatches || listResult.truncated,
    truncatedFiles,
    matches,
  };
}

export async function writeWorkspaceFile(root: string, options: FilesystemWriteOptions): Promise<FilesystemWriteResult> {
  const resolvedPath = normalizeWorkspacePath(options.path, root, 'write');
  let existingContent: string | null = null;

  try {
    existingContent = await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  if (existingContent !== null) {
    if (existingContent === options.content) {
      return {
        path: options.path,
        status: 'unchanged',
        bytesWritten: Buffer.byteLength(options.content, 'utf-8'),
      };
    }
    if (options.overwrite !== true) {
      throw new Error('fs write refuses to overwrite an existing file without overwrite=true');
    }
  }

  await writeFile(resolvedPath, options.content, 'utf-8');
  return {
    path: options.path,
    status: existingContent === null ? 'created' : 'overwritten',
    bytesWritten: Buffer.byteLength(options.content, 'utf-8'),
  };
}

export async function editWorkspaceFile(root: string, options: FilesystemEditOptions): Promise<FilesystemEditResult> {
  const resolvedPath = normalizeWorkspacePath(options.path, root, 'edit');
  if (typeof options.oldText !== 'string' || options.oldText.length === 0) {
    throw new Error('fs edit requires a non-empty oldText');
  }

  const content = await readFile(resolvedPath, 'utf-8');
  const parts = content.split(options.oldText);
  const occurrences = parts.length - 1;
  if (occurrences <= 0) {
    throw new Error('fs edit could not find oldText in the target file');
  }
  if (options.replaceAll !== true && occurrences !== 1) {
    throw new Error('fs edit found multiple matches; retry with replaceAll=true or use a more specific oldText');
  }

  const nextContent = options.replaceAll === true
    ? parts.join(options.newText)
    : content.replace(options.oldText, options.newText);
  if (nextContent !== content) {
    await writeFile(resolvedPath, nextContent, 'utf-8');
  }

  return {
    path: options.path,
    replacements: options.replaceAll === true ? occurrences : 1,
  };
}
