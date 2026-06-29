import { JSONRPCErrorException } from 'json-rpc-2.0';
import { writeFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import type {
  FsEditParams,
  FsListParams,
  FsReadParams,
  FsSearchParams,
  FsWriteParams,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { isInsideAllowedPaths } from '../policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from '../filesystem-paths.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import {
  buildWorkingFolderSearchGlob,
  collectBoundedGlobFiles,
  editWorkspaceFile,
  isBroadSearchGlob,
  normalizeListLimits,
  readTextFile,
  searchWorkspaceFiles,
} from '../../integrations/filesystem/workspace-ops.js';

function resolveReadRoot(runtime: GatewayMethodRuntime): string {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const fullCodebaseReadRoot = runtime.policyConfig.fullCodebaseReadRoot;
  if (typeof fullCodebaseReadRoot !== 'string' || fullCodebaseReadRoot.trim().length === 0) {
    return workspaceRoot;
  }
  return resolveWorkspaceRoot(fullCodebaseReadRoot);
}

async function resolveReadPath(path: string, runtime: GatewayMethodRuntime): Promise<string> {
  if (isAbsolute(path)) {
    return resolveWorkspaceFsPathFromRoot(path, resolveWorkspaceRoot(runtime.workspacePath));
  }
  const workspaceCandidate = resolveWorkspaceFsPathFromRoot(path, resolveWorkspaceRoot(runtime.workspacePath));
  if (await pathExists(workspaceCandidate)) {
    return workspaceCandidate;
  }
  return resolveWorkspaceFsPathFromRoot(path, resolveReadRoot(runtime));
}

function relativePathForDisplay(path: string, root: string): string {
  return relative(root, path).replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

function summarizeSearchGlob(glob: string | undefined): string {
  return typeof glob === 'string' && !isBroadSearchGlob(glob) ? glob : 'working-folders';
}

function resolveDefaultSearchGlob(runtime: GatewayMethodRuntime): string {
  const readRoot = resolveReadRoot(runtime);
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const workspaceRelativeToReadRoot = relative(readRoot, workspaceRoot).replace(/\\/g, '/');
  if (
    workspaceRelativeToReadRoot.length > 0
    && !workspaceRelativeToReadRoot.startsWith('../')
    && workspaceRelativeToReadRoot !== '..'
    && !isAbsolute(workspaceRelativeToReadRoot)
  ) {
    return buildWorkingFolderSearchGlob(workspaceRelativeToReadRoot);
  }
  return buildWorkingFolderSearchGlob();
}

function toErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveListBase(
  params: FsListParams,
  runtime: GatewayMethodRuntime,
): Promise<{ cwd: string; displayRoot: string; glob: string }> {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const readRoot = resolveReadRoot(runtime);
  const requestedPath = typeof params.path === 'string' && params.path.trim().length > 0
    ? params.path.trim()
    : '';
  const requestedGlob = typeof params.glob === 'string' ? params.glob : undefined;
  const normalizedGlob = normalizeWorkspaceRelativeGlob(
    isBroadSearchGlob(requestedGlob) ? '*' : requestedGlob,
  );
  if (!normalizedGlob) {
    throw new JSONRPCErrorException(
      'fs.list glob must be a non-empty workspace-relative pattern',
      GatewayErrors.POLICY_DENIED,
    );
  }

  if (requestedPath.length === 0 && isBroadSearchGlob(requestedGlob)) {
    return { cwd: workspaceRoot, displayRoot: workspaceRoot, glob: '*' };
  }

  if (requestedPath.length === 0) {
    return { cwd: readRoot, displayRoot: readRoot, glob: normalizedGlob };
  }

  const cwd = await resolveReadPath(requestedPath, runtime);
  const cwdStat = await stat(cwd);
  if (!cwdStat.isDirectory()) {
    throw new JSONRPCErrorException(
      `fs.list path must resolve to a directory: ${requestedPath}`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  const canonicalCwd = await realpath(cwd);
  if (!isInsideAllowedPaths(canonicalCwd, [workspaceRoot, readRoot])) {
    throw new JSONRPCErrorException(
      `fs.list path must stay inside an allowed read root: ${requestedPath}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  const displayRoot = isInsideAllowedPaths(canonicalCwd, [workspaceRoot]) ? workspaceRoot : readRoot;
  return { cwd: canonicalCwd, displayRoot, glob: normalizedGlob };
}

function stripKnownRootPrefix(path: string, workspaceRoot: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const workspaceName = basename(workspaceRoot);
  for (const prefix of [workspaceName, 'workspace']) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return normalized.slice(prefix.length).replace(/^\/+/, '');
    }
  }
  return null;
}

async function buildWriteFailureMessage(
  requestedPath: string,
  workspaceRoot: string,
  resolvedPath: string,
  error: unknown,
): Promise<string> {
  const code = toErrorCode(error);
  const parentDir = dirname(resolvedPath);
  const parentExists = await pathExists(parentDir);
  const relativeResolved = relative(workspaceRoot, resolvedPath).replace(/\\/g, '/');
  const correctedRelativePath = stripKnownRootPrefix(requestedPath, workspaceRoot);
  const guidance = [
    `fs.write failed for "${requestedPath}" (${code ?? 'unknown error'}).`,
    `Writes are personal-root-relative; personal root is ${workspaceRoot}.`,
    `Resolved target: ${resolvedPath}.`,
    `Workspace-relative target: ${relativeResolved || '.'}.`,
    parentExists
      ? `Parent directory exists: ${parentDir}.`
      : `Missing parent directory: ${parentDir}.`,
  ];
  if (correctedRelativePath) {
    guidance.push(`The path appears to include a root prefix; retry with "${correctedRelativePath}".`);
  }
  return guidance.join(' ');
}

const fsDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'fs.read',
    handler: async (params: FsReadParams, runtime) => {
      const resolvedPath = await resolveReadPath(params.path, runtime);
      return await readTextFile(resolvedPath, params.maxBytes);
    },
    summary: (p: FsReadParams) => ({ path: p.path, maxBytes: p.maxBytes }),
    approvalAction: 'read',
    approvalScope: (p: FsReadParams) => p.path,
  },
  {
    name: 'fs.write',
    handler: async (params: FsWriteParams, runtime) => {
      const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
      const resolvedPath = resolveWorkspaceFsPathFromRoot(params.path, workspaceRoot);
      try {
        await writeFile(resolvedPath, params.content, 'utf-8');
      } catch (error) {
        throw new JSONRPCErrorException(
          await buildWriteFailureMessage(params.path, workspaceRoot, resolvedPath, error),
          GatewayErrors.PROVIDER_ERROR,
        );
      }
      return { success: true };
    },
    summary: (p: FsWriteParams) => ({ path: p.path }),
    approvalAction: 'write',
    approvalScope: (p: FsWriteParams) => p.path,
  },
  {
    name: 'fs.list',
    handler: async (params: FsListParams, runtime) => {
      const limits = normalizeListLimits(params.maxEntries, params.maxScannedEntries);

      const listBase = await resolveListBase(params, runtime);
      return collectBoundedGlobFiles({
        cwd: listBase.cwd,
        glob: listBase.glob,
        allowedRoots: [listBase.cwd],
        ...limits,
        toDisplayPath: absolutePath => relativePathForDisplay(absolutePath, listBase.displayRoot),
      });
    },
    summary: (p: FsListParams) => ({
      path: p.path,
      glob: p.glob ?? '*',
      maxEntries: p.maxEntries ?? 200,
      maxScannedEntries: p.maxScannedEntries ?? 5_000,
    }),
    approvalAction: 'read',
    approvalScope: (p: FsListParams) => `${p.path ?? '.'}:${p.glob ?? '*'}`,
  },
  {
    name: 'fs.search',
    handler: async (params: FsSearchParams, runtime) => {
      return await searchWorkspaceFiles(resolveReadRoot(runtime), {
        query: params.query,
        ...(typeof params.glob === 'string' && !isBroadSearchGlob(params.glob)
          ? { glob: params.glob }
          : { glob: resolveDefaultSearchGlob(runtime) }),
        ...(params.mode ? { mode: params.mode } : {}),
        ...(typeof params.maxMatches === 'number' ? { maxMatches: params.maxMatches } : {}),
        ...(typeof params.maxFiles === 'number' ? { maxFiles: params.maxFiles } : {}),
        ...(typeof params.maxBytesPerFile === 'number' ? { maxBytesPerFile: params.maxBytesPerFile } : {}),
        ...(typeof params.contextLines === 'number' ? { contextLines: params.contextLines } : {}),
      });
    },
    summary: (p: FsSearchParams) => ({
      query: p.query,
      glob: summarizeSearchGlob(p.glob),
      maxMatches: p.maxMatches ?? 50,
      maxFiles: p.maxFiles ?? 200,
    }),
    approvalAction: 'read',
    approvalScope: (p: FsSearchParams) => `${summarizeSearchGlob(p.glob)}:${p.query}`,
  },
  {
    name: 'fs.edit',
    handler: async (params: FsEditParams, runtime) => {
      const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
      const result = await editWorkspaceFile(workspaceRoot, {
        path: params.path,
        oldText: params.oldText,
        newText: params.newText,
        replaceAll: params.replaceAll,
      });
      return {
        success: true,
        replacements: result.replacements,
      };
    },
    summary: (p: FsEditParams) => ({ path: p.path, replaceAll: p.replaceAll === true }),
    approvalAction: 'write',
    approvalScope: (p: FsEditParams) => p.path,
  },
];

export function registerFilesystemMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, fsDescriptors);
}
