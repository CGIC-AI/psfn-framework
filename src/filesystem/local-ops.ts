import { glob as fsGlob, readFile } from 'node:fs/promises';
import type { FilesystemReadOperations } from './ops.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from '../boundary/gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../boundary/gateway/policy.js';

const DEFAULT_LIST_GLOB = '**/*';
const DEFAULT_LIST_MAX_ENTRIES = 200;
const MAX_LIST_MAX_ENTRIES = 500;

export class WorkspaceFilesystemOps implements FilesystemReadOperations {
  private readonly workspaceRoot: string;

  constructor(workspacePath: string) {
    this.workspaceRoot = resolveWorkspaceRoot(workspacePath);
  }

  async read(path: string): Promise<string> {
    const resolvedPath = resolveWorkspaceFsPathFromRoot(path, this.workspaceRoot);
    if (!isInsideAllowedPaths(resolvedPath, [this.workspaceRoot])) {
      throw new Error('fs_read path must stay inside the workspace root');
    }
    return readFile(resolvedPath, 'utf-8');
  }

  async list(glob = DEFAULT_LIST_GLOB, maxEntries = DEFAULT_LIST_MAX_ENTRIES): Promise<string[]> {
    const normalizedGlob = normalizeWorkspaceRelativeGlob(glob);
    if (!normalizedGlob) {
      throw new Error('fs_list glob must be a non-empty workspace-relative pattern');
    }

    const boundedMaxEntries = Number.isFinite(maxEntries)
      ? Math.max(1, Math.min(MAX_LIST_MAX_ENTRIES, Math.floor(Number(maxEntries))))
      : DEFAULT_LIST_MAX_ENTRIES;

    const paths: string[] = [];
    for await (const match of fsGlob(normalizedGlob, { cwd: this.workspaceRoot })) {
      const relative = String(match).replace(/\\/g, '/').replace(/^\.\//, '');
      const absolute = resolveWorkspaceFsPathFromRoot(relative, this.workspaceRoot);
      if (!isInsideAllowedPaths(absolute, [this.workspaceRoot])) {
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
}
