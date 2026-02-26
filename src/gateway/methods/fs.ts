import { JSONRPCErrorException } from 'json-rpc-2.0';
import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import type { FsListParams, FsReadParams, FsWriteParams } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { isInsideAllowedPaths } from '../policy.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';

const fsDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'fs.read',
    handler: async (params: FsReadParams) => {
      const content = await readFile(params.path, 'utf-8');
      return { content };
    },
    summary: (p: FsReadParams) => ({ path: p.path }),
    approvalAction: 'read',
    approvalScope: (p: FsReadParams) => p.path,
  },
  {
    name: 'fs.write',
    handler: async (params: FsWriteParams) => {
      await writeFile(params.path, params.content, 'utf-8');
      return { success: true };
    },
    summary: (p: FsWriteParams) => ({ path: p.path }),
    approvalAction: 'write',
    approvalScope: (p: FsWriteParams) => p.path,
  },
  {
    name: 'fs.list',
    handler: async (params: FsListParams, runtime) => {
      const rawGlob = typeof params.glob === 'string' ? params.glob.trim() : '**/*';
      const normalizedGlob = rawGlob.replace(/\\/g, '/');
      if (
        !normalizedGlob ||
        normalizedGlob.length > 512 ||
        normalizedGlob.includes('\0') ||
        normalizedGlob.startsWith('/') ||
        normalizedGlob.startsWith('\\') ||
        /(^|\/)\.\.(\/|$)/.test(normalizedGlob)
      ) {
        throw new JSONRPCErrorException(
          'fs.list glob must be a non-empty workspace-relative pattern',
          GatewayErrors.POLICY_DENIED,
        );
      }

      const maxEntries = Number.isFinite(params.maxEntries)
        ? Math.max(1, Math.min(500, Math.floor(Number(params.maxEntries))))
        : 200;

      const workspaceRoot = resolve(normalize(runtime.workspacePath));
      const paths: string[] = [];
      for await (const match of fsGlob(normalizedGlob, {
        cwd: workspaceRoot,
        withFileTypes: false,
        dot: true,
      })) {
        const relative = String(match).replace(/\\/g, '/').replace(/^\.\//, '');
        const absolute = resolve(workspaceRoot, relative);
        if (!isInsideAllowedPaths(absolute, [workspaceRoot])) {
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
