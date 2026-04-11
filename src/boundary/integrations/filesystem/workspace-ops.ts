import { glob as fsGlob, open, readFile, writeFile } from 'node:fs/promises';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
} from '../../gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemReadResult,
  FilesystemSearchMatch,
  FilesystemSearchMode,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';

const DEFAULT_LIST_GLOB = '**/*';
const DEFAULT_LIST_MAX_ENTRIES = 200;
const MAX_LIST_MAX_ENTRIES = 500;
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

function clampFiniteInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchMode(value: unknown): FilesystemSearchMode {
  return value === 'regex' ? 'regex' : DEFAULT_SEARCH_MODE;
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

export async function listWorkspaceFiles(root: string, glob = DEFAULT_LIST_GLOB, maxEntries = DEFAULT_LIST_MAX_ENTRIES): Promise<string[]> {
  const normalizedGlob = normalizeWorkspaceRelativeGlob(glob);
  if (!normalizedGlob) {
    throw new Error('fs list glob must be a non-empty workspace-relative pattern');
  }

  const boundedMaxEntries = clampFiniteInteger(maxEntries, DEFAULT_LIST_MAX_ENTRIES, 1, MAX_LIST_MAX_ENTRIES);
  const paths: string[] = [];

  for await (const match of fsGlob(normalizedGlob, { cwd: root })) {
    const relative = String(match).replace(/\\/g, '/').replace(/^\.\//, '');
    const absolute = resolveWorkspaceFsPathFromRoot(relative, root);
    if (!isInsideAllowedPaths(absolute, [root])) {
      continue;
    }
    paths.push(relative);
    if (paths.length >= boundedMaxEntries) {
      break;
    }
  }

  paths.sort((left, right) => left.localeCompare(right));
  return paths;
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

  const normalizedGlob = normalizeWorkspaceRelativeGlob(options.glob);
  if (!normalizedGlob) {
    throw new Error('fs search glob must be a non-empty workspace-relative pattern');
  }

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
  const paths = await listWorkspaceFiles(root, normalizedGlob, maxFiles);
  const matches: FilesystemSearchMatch[] = [];
  const truncatedFiles: string[] = [];
  let scannedFiles = 0;

  for (const path of paths) {
    const absolutePath = resolveWorkspaceFsPathFromRoot(path, root);
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
    hitLimit: matches.length >= maxMatches,
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
