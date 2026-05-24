import { JSONRPCErrorException } from 'json-rpc-2.0';
import { writeFile, glob as fsGlob, stat } from 'node:fs/promises';
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
  editWorkspaceFile,
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

function resolveReadPath(path: string, runtime: GatewayMethodRuntime): string {
  if (isAbsolute(path)) {
    return resolveWorkspaceFsPathFromRoot(path, resolveWorkspaceRoot(runtime.workspacePath));
  }
  return resolveWorkspaceFsPathFromRoot(path, resolveReadRoot(runtime));
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
      const resolvedPath = resolveReadPath(params.path, runtime);
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
      const normalizedGlob = normalizeWorkspaceRelativeGlob(params.glob);
      if (!normalizedGlob) {
        throw new JSONRPCErrorException(
          'fs.list glob must be a non-empty workspace-relative pattern',
          GatewayErrors.POLICY_DENIED,
        );
      }

      const maxEntries = Number.isFinite(params.maxEntries)
        ? Math.max(1, Math.min(500, Math.floor(Number(params.maxEntries))))
        : 200;

      const readRoot = resolveReadRoot(runtime);
      const paths: string[] = [];
      for await (const match of fsGlob(normalizedGlob, {
        cwd: readRoot,
      })) {
        const relative = String(match).replace(/\\/g, '/').replace(/^\.\//, '');
        const absolute = resolveWorkspaceFsPathFromRoot(relative, readRoot);
        if (!isInsideAllowedPaths(absolute, [readRoot])) {
          continue;
        }
        paths.push(relative);
        if (paths.length >= maxEntries) {
          break;
        }
      }

      paths.sort((a, b) => a.localeCompare(b));
      return { paths };
    },
    summary: (p: FsListParams) => ({ glob: p.glob ?? '**/*', maxEntries: p.maxEntries ?? 200 }),
    approvalAction: 'read',
    approvalScope: (p: FsListParams) => p.glob ?? '**/*',
  },
  {
    name: 'fs.search',
    handler: async (params: FsSearchParams, runtime) => {
      return await searchWorkspaceFiles(resolveReadRoot(runtime), {
        query: params.query,
        ...(typeof params.glob === 'string' ? { glob: params.glob } : {}),
        ...(params.mode ? { mode: params.mode } : {}),
        ...(typeof params.maxMatches === 'number' ? { maxMatches: params.maxMatches } : {}),
        ...(typeof params.maxFiles === 'number' ? { maxFiles: params.maxFiles } : {}),
        ...(typeof params.maxBytesPerFile === 'number' ? { maxBytesPerFile: params.maxBytesPerFile } : {}),
        ...(typeof params.contextLines === 'number' ? { contextLines: params.contextLines } : {}),
      });
    },
    summary: (p: FsSearchParams) => ({
      query: p.query,
      glob: p.glob ?? '**/*',
      maxMatches: p.maxMatches ?? 50,
      maxFiles: p.maxFiles ?? 200,
    }),
    approvalAction: 'read',
    approvalScope: (p: FsSearchParams) => `${p.glob ?? '**/*'}:${p.query}`,
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
