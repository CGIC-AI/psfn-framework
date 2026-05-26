import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemListOptions,
  FilesystemOperations,
  FilesystemReadOptions,
  FilesystemReadResult,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';
import { resolveWorkspaceFsPathFromRoot, resolveWorkspaceRoot } from '../../gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import {
  editWorkspaceFile,
  listWorkspaceFiles,
  readTextFile,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from './workspace-ops.js';

const DEFAULT_LIST_GLOB = '**/*';
const DEFAULT_LIST_MAX_ENTRIES = 200;

export class WorkspaceFilesystemOps implements FilesystemOperations {
  private readonly workspaceRoot: string;

  constructor(workspacePath: string) {
    this.workspaceRoot = resolveWorkspaceRoot(workspacePath);
  }

  async read(path: string, options?: FilesystemReadOptions): Promise<FilesystemReadResult> {
    const resolvedPath = resolveWorkspaceFsPathFromRoot(path, this.workspaceRoot);
    if (!isInsideAllowedPaths(resolvedPath, [this.workspaceRoot])) {
      throw new Error('fs read path must stay inside the workspace root');
    }
    return readTextFile(resolvedPath, options?.maxBytes);
  }

  async list(
    glob = DEFAULT_LIST_GLOB,
    maxEntries = DEFAULT_LIST_MAX_ENTRIES,
    options?: FilesystemListOptions,
  ): Promise<string[]> {
    return listWorkspaceFiles(this.workspaceRoot, glob, maxEntries, options);
  }

  async search(options: FilesystemSearchOptions): Promise<FilesystemSearchResult> {
    return searchWorkspaceFiles(this.workspaceRoot, options);
  }

  async write(options: FilesystemWriteOptions): Promise<FilesystemWriteResult> {
    return writeWorkspaceFile(this.workspaceRoot, options);
  }

  async edit(options: FilesystemEditOptions): Promise<FilesystemEditResult> {
    return editWorkspaceFile(this.workspaceRoot, options);
  }
}
