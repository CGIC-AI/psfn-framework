import { JSONRPCErrorException } from 'json-rpc-2.0';
import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FsListParams, FsReadParams, FsWriteParams } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { isInsideAllowedPaths } from '../policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from '../filesystem-paths.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';

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

const fsDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'fs.read',
    handler: async (params: FsReadParams, runtime) => {
      const resolvedPath = resolveReadPath(params.path, runtime);
      const content = await readFile(resolvedPath, 'utf-8');
      return { content };
    },
    summary: (p: FsReadParams) => ({ path: p.path }),
    approvalAction: 'read',
    approvalScope: (p: FsReadParams) => p.path,
  },
  {
    name: 'fs.write',
    handler: async (params: FsWriteParams, runtime) => {
      const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
      const resolvedPath = resolveWorkspaceFsPathFromRoot(params.path, workspaceRoot);
      await writeFile(resolvedPath, params.content, 'utf-8');
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
        withFileTypes: false,
        dot: true,
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
];

export function registerFilesystemMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, fsDescriptors);
}
