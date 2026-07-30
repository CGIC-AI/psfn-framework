import type { FsListView, GatewayREPLCapabilities, SandboxBudgetRef } from './contracts.js';
import {
  FILESYSTEM_READ_PAGE_CONTRACT,
  validateFilesystemReadMaxBytes,
} from '../../../shared/contracts/filesystem.js';
import type {
  SandboxFileRead,
  SandboxFileReadPage,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';
import {
  consumeToolCallBudget,
  toErrorMessage,
  toTrimmedString,
  TOOL_CALL_BUDGET_EXCEEDED_MESSAGE,
} from './common.js';

const DEFAULT_LIST_FILES_GLOB = '**/*';
const DEFAULT_LIST_FILES_MAX_ENTRIES = 200;
const MAX_LIST_FILES_GLOB_LENGTH = 512;
const MAX_WRITE_FILE_CONTENT_CHARS = 500_000;

export interface ReadFileOptions {
  offsetBytes?: number;
}

export type ReadFileResult = SandboxFileReadPage | { error: string };

export interface ToolchainCapabilities {
  read_file: (path: string, options?: ReadFileOptions) => Promise<ReadFileResult>;
  write_file: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  list_files: (glob?: string, maxEntries?: number) => Promise<FsListView | { error: string }>;
}

interface CreateToolchainCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  fileRead?: SandboxFileRead;
  fsReadMaxBytes?: number;
  budgetRef?: SandboxBudgetRef;
}

function normalizePath(input: unknown): string {
  const trimmed = toTrimmedString(input);
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) {
    return '';
  }
  return trimmed;
}

function normalizeGlob(input: unknown): { glob: string } | { error: string } {
  const fallback = DEFAULT_LIST_FILES_GLOB;
  const raw = typeof input === 'string' ? input.trim() : '';
  const candidate = raw || fallback;
  if (candidate.length > MAX_LIST_FILES_GLOB_LENGTH) {
    return { error: `glob pattern too long (max ${MAX_LIST_FILES_GLOB_LENGTH} chars)` };
  }
  if (candidate.includes('\0')) {
    return { error: 'glob pattern contains invalid null byte' };
  }
  if (candidate.startsWith('/') || candidate.startsWith('\\')) {
    return { error: 'glob pattern must be workspace-relative' };
  }
  const normalized = candidate.replace(/\\/g, '/');
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) {
    return { error: 'glob pattern may not traverse outside workspace' };
  }
  return { glob: normalized };
}

function normalizeMaxEntries(value: unknown): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIST_FILES_MAX_ENTRIES;
  }
  return Math.max(1, Math.min(DEFAULT_LIST_FILES_MAX_ENTRIES, Math.floor(Number(value))));
}

function normalizeReadOffset(value: unknown): { offsetBytes: number } | { error: string } {
  const offsetBytes = value ?? 0;
  if (
    typeof offsetBytes !== 'number'
    || !Number.isSafeInteger(offsetBytes)
    || offsetBytes < 0
    || offsetBytes > FILESYSTEM_READ_PAGE_CONTRACT.maxOffsetBytes
  ) {
    return {
      error:
        `offsetBytes must be a safe integer between 0 and `
        + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxOffsetBytes)}`,
    };
  }
  return { offsetBytes };
}

function normalizeConfiguredReadMaxBytes(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  try {
    return validateFilesystemReadMaxBytes(value);
  } catch {
    return null;
  }
}

export function createToolchainCapabilities(
  options: CreateToolchainCapabilitiesOptions,
): ToolchainCapabilities {
  const configuredReadMaxBytes = normalizeConfiguredReadMaxBytes(options.fsReadMaxBytes);
  const read_file = async (
    path: string,
    readOptions?: ReadFileOptions,
  ): Promise<ReadFileResult> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return { error: TOOL_CALL_BUDGET_EXCEEDED_MESSAGE };
    }
    if (typeof options.fileRead !== 'function') {
      return { error: 'read_file unavailable: requires governed gateway fs.read paging and audit path' };
    }
    if (configuredReadMaxBytes === null) {
      return {
        error:
          'read_file unavailable: fsReadMaxBytes must be a configured safe integer between '
          + `${String(FILESYSTEM_READ_PAGE_CONTRACT.minBytes)} and `
          + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxBytes)}`,
      };
    }

    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return { error: 'path is required' };
    }
    const normalizedOffset = normalizeReadOffset(readOptions?.offsetBytes);
    if ('error' in normalizedOffset) {
      return normalizedOffset;
    }

    try {
      return await options.fileRead(normalizedPath, {
        maxBytes: configuredReadMaxBytes,
        offsetBytes: normalizedOffset.offsetBytes,
      });
    } catch (err) {
      return { error: toErrorMessage(err) };
    }
  };

  const write_file = async (
    path: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return { ok: false, error: TOOL_CALL_BUDGET_EXCEEDED_MESSAGE };
    }
    if (typeof options.gatewayCaps.fsWrite !== 'function') {
      return { ok: false, error: 'write_file unavailable: requires gateway fs.write policy and audit path' };
    }

    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return { ok: false, error: 'path is required' };
    }
    if (typeof content !== 'string') {
      return { ok: false, error: 'content must be a string' };
    }
    if (content.length > MAX_WRITE_FILE_CONTENT_CHARS) {
      return {
        ok: false,
        error: `content too large (max ${MAX_WRITE_FILE_CONTENT_CHARS} chars)`,
      };
    }

    try {
      await options.gatewayCaps.fsWrite(normalizedPath, content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  };

  const list_files = async (
    glob?: string,
    maxEntries?: number,
  ): Promise<FsListView | { error: string }> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return { error: TOOL_CALL_BUDGET_EXCEEDED_MESSAGE };
    }
    if (typeof options.gatewayCaps.fsList !== 'function') {
      return { error: 'list_files unavailable: requires gateway fs.list policy and audit path' };
    }

    const normalizedGlob = normalizeGlob(glob);
    if ('error' in normalizedGlob) {
      return { error: normalizedGlob.error };
    }

    try {
      return await options.gatewayCaps.fsList(normalizedGlob.glob, normalizeMaxEntries(maxEntries));
    } catch (err) {
      return { error: toErrorMessage(err) };
    }
  };

  return {
    read_file,
    write_file,
    list_files,
  };
}
