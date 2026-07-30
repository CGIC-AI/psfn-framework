import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemListOptions,
  FilesystemListResult,
  FilesystemOperations,
  FilesystemReadOptions,
  FilesystemReadResult,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';
import { normalizeFilesystemReadOptions } from './ops.js';
import {
  normalizeWorkspacePathInput,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from '../../gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  editWorkspaceFile,
  listWorkspaceFiles,
  readTextFile,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from './workspace-ops.js';

const DEFAULT_LIST_GLOB = '**/*';
const DEFAULT_LIST_MAX_ENTRIES = 200;
const log = createComponentLogger('WorkspaceFilesystem');

export class WorkspaceFilesystemOps implements FilesystemOperations {
  private readonly workspaceRoot: string;

  constructor(workspacePath: string) {
    this.workspaceRoot = resolveWorkspaceRoot(workspacePath);
  }

  private normalizePath(path: string): string {
    const normalized = normalizeWorkspacePathInput(path, this.workspaceRoot);
    if (normalized.ambiguity) {
      throw new Error(
        `${normalized.ambiguity}; expected a Personal Workspace-relative path `
        + 'such as "notes/example.txt"',
      );
    }
    if (normalized.strippedPrefix) {
      log.warn('Stripped duplicated Personal Workspace prefix from filesystem path', {
        requestedPath: path,
        strippedPrefix: normalized.strippedPrefix,
        normalizedPath: normalized.path,
      });
    }
    return normalized.path;
  }

  async read(path: string, options?: FilesystemReadOptions): Promise<FilesystemReadResult> {
    const resolvedPath = resolveWorkspaceFsPathFromRoot(
      this.normalizePath(path),
      this.workspaceRoot,
    );
    if (!isInsideAllowedPaths(resolvedPath, [this.workspaceRoot])) {
      throw new Error('fs read path must stay inside the workspace root');
    }
    const normalizedOptions = normalizeFilesystemReadOptions(options);
    return readTextFile(
      resolvedPath,
      normalizedOptions.maxBytes,
      normalizedOptions.offsetBytes,
    );
  }

  async list(
    glob = DEFAULT_LIST_GLOB,
    maxEntries = DEFAULT_LIST_MAX_ENTRIES,
    options?: FilesystemListOptions,
  ): Promise<FilesystemListResult> {
    return listWorkspaceFiles(this.workspaceRoot, glob, maxEntries, options);
  }

  async search(options: FilesystemSearchOptions): Promise<FilesystemSearchResult> {
    return searchWorkspaceFiles(this.workspaceRoot, options);
  }

  async write(options: FilesystemWriteOptions): Promise<FilesystemWriteResult> {
    return writeWorkspaceFile(this.workspaceRoot, {
      ...options,
      path: this.normalizePath(options.path),
    });
  }

  async edit(options: FilesystemEditOptions): Promise<FilesystemEditResult> {
    return editWorkspaceFile(this.workspaceRoot, {
      ...options,
      path: this.normalizePath(options.path),
    });
  }
}
