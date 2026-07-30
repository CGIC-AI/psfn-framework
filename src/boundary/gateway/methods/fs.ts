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
  normalizeWorkspacePathInput,
  normalizeWorkspaceRelativeGlob,
  resolveCanonicalPath,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from '../filesystem-paths.js';
import { createComponentLogger } from '../../../shared/logger.js';
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
import { normalizeFilesystemReadOptions } from '../../integrations/filesystem/ops.js';

const log = createComponentLogger('GatewayFilesystem');

function resolveReadRoot(runtime: GatewayMethodRuntime): string {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const fullCodebaseReadRoot = runtime.policyConfig.fullCodebaseReadRoot;
  if (typeof fullCodebaseReadRoot !== 'string' || fullCodebaseReadRoot.trim().length === 0) {
    return workspaceRoot;
  }
  return resolveWorkspaceRoot(fullCodebaseReadRoot);
}

interface ResolvedReadPath {
  path: string;
  scope: 'personal-workspace' | 'explicit-absolute' | 'codebase-fallback';
}

function normalizeRequestedWorkspacePath(path: string, workspaceRoot: string): string {
  try {
    const normalized = normalizeWorkspacePathInput(path, workspaceRoot);
    if (normalized.ambiguity) {
      throw new Error(normalized.ambiguity);
    }
    if (normalized.strippedPrefix) {
      log.warn('Stripped duplicated Personal Workspace prefix from filesystem path', {
        requestedPath: path,
        strippedPrefix: normalized.strippedPrefix,
        normalizedPath: normalized.path,
      });
    }
    return normalized.path;
  } catch (error) {
    throw new JSONRPCErrorException(
      `${error instanceof Error ? error.message : String(error)}; `
      + 'expected a Personal Workspace-relative path such as "notes/example.txt"',
      GatewayErrors.POLICY_DENIED,
    );
  }
}

async function resolveReadPath(path: string, runtime: GatewayMethodRuntime): Promise<ResolvedReadPath> {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const normalizedPath = normalizeRequestedWorkspacePath(path, workspaceRoot);
  if (isAbsolute(normalizedPath)) {
    return {
      path: resolveWorkspaceFsPathFromRoot(normalizedPath, workspaceRoot),
      scope: 'explicit-absolute',
    };
  }
  const workspaceCandidate = resolveWorkspaceFsPathFromRoot(normalizedPath, workspaceRoot);
  if (await pathExists(workspaceCandidate)) {
    return { path: workspaceCandidate, scope: 'personal-workspace' };
  }
  const readRoot = resolveReadRoot(runtime);
  if (readRoot === workspaceRoot) {
    return { path: workspaceCandidate, scope: 'personal-workspace' };
  }
  return {
    path: resolveWorkspaceFsPathFromRoot(normalizedPath, readRoot),
    scope: 'codebase-fallback',
  };
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

function assertPersonalWorkspacePath(
  resolvedPath: string,
  runtime: GatewayMethodRuntime,
  missingPathBehavior: 'returnNormalized' | 'resolveParent',
): void {
  if (!runtime.personalWorkspaceIsolation) return;
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const canonical = resolveCanonicalPath(resolvedPath, {
    missingPathBehavior,
    errorBehavior: 'deny',
  });
  if (!canonical || !isInsideAllowedPaths(canonical, [workspaceRoot])) {
    throw new JSONRPCErrorException(
      'Fleet filesystem access must stay inside the authenticated companion Personal Workspace',
      GatewayErrors.POLICY_DENIED,
    );
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

  const resolvedReadPath = await resolveReadPath(requestedPath, runtime);
  const cwd = resolvedReadPath.path;
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

function assertQuarantinedArtifactMutationAllowed(
  resolvedPath: string,
  runtime: GatewayMethodRuntime,
  via: 'gateway:fs.write' | 'gateway:fs.edit',
): void {
  const verdict = runtime.quarantinedArtifactGuard?.check(resolvedPath, { via });
  if (!verdict?.withheld) return;
  throw new JSONRPCErrorException(
    verdict.noticeText,
    GatewayErrors.POLICY_DENIED,
  );
}

function resolveGuardedMutationPath(
  requestedPath: string,
  runtime: GatewayMethodRuntime,
  missingPathBehavior: 'returnNormalized' | 'resolveParent',
  via: 'gateway:fs.write' | 'gateway:fs.edit',
): { workspaceRoot: string; normalizedPath: string; resolvedPath: string } {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const normalizedPath = normalizeRequestedWorkspacePath(requestedPath, workspaceRoot);
  const resolvedPath = resolveWorkspaceFsPathFromRoot(normalizedPath, workspaceRoot);
  assertPersonalWorkspacePath(resolvedPath, runtime, missingPathBehavior);
  assertQuarantinedArtifactMutationAllowed(resolvedPath, runtime, via);
  return { workspaceRoot, normalizedPath, resolvedPath };
}

const fsDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'fs.read',
    handler: async (params: FsReadParams, runtime) => {
      const resolved = await resolveReadPath(params.path, runtime);
      if (runtime.personalWorkspaceIsolation && resolved.scope === 'codebase-fallback') {
        throw new JSONRPCErrorException(
          'fs.read codebase fallback is unavailable under Personal Workspace isolation; '
          + 'request a path inside the authenticated companion Personal Workspace',
          GatewayErrors.POLICY_DENIED,
        );
      }
      assertPersonalWorkspacePath(resolved.path, runtime, 'returnNormalized');
      // hrmrq.54: a quarantined item's on-disk artifact must never be served
      // back into the turn while the item awaits operator review — the read
      // returns the fixed quarantine notice and the attempt is recorded on
      // the Garden queue entry.
      const guardVerdict = runtime.quarantinedArtifactGuard?.check(resolved.path, {
        via: 'gateway:fs.read',
      });
      if (guardVerdict?.withheld) {
        return {
          content: guardVerdict.noticeText,
          offsetBytes: 0,
          nextOffsetBytes: null,
          eof: true,
          truncated: false,
        };
      }
      const options = normalizeFilesystemReadOptions({
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        ...(params.offsetBytes !== undefined ? { offsetBytes: params.offsetBytes } : {}),
      });
      return await readTextFile(resolved.path, options.maxBytes, options.offsetBytes);
    },
    summary: (p: FsReadParams) => ({
      path: p.path,
      maxBytes: p.maxBytes,
      offsetBytes: p.offsetBytes,
    }),
    approvalAction: 'read',
    approvalScope: (p: FsReadParams) => p.path,
  },
  {
    name: 'fs.write',
    handler: async (params: FsWriteParams, runtime) => {
      const { workspaceRoot, resolvedPath } = resolveGuardedMutationPath(
        params.path,
        runtime,
        'resolveParent',
        'gateway:fs.write',
      );
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
      const searchRoot = resolveReadRoot(runtime);
      const result = await searchWorkspaceFiles(searchRoot, {
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
      // hrmrq.54: search previews are a read seam too — a quarantined
      // artifact's lines must not leak through match previews. One guard
      // verdict per distinct matched file; withheld files drop out of the
      // result and the attempt lands on the Garden queue entry.
      const guard = runtime.quarantinedArtifactGuard;
      if (!guard) return result;
      const verdictByRelativePath = new Map<string, boolean>();
      const isWithheld = (relativePath: string): boolean => {
        const cached = verdictByRelativePath.get(relativePath);
        if (cached !== undefined) return cached;
        const absolutePath = resolveWorkspaceFsPathFromRoot(relativePath, searchRoot);
        const withheld = guard.check(absolutePath, { via: 'gateway:fs.search' }).withheld;
        verdictByRelativePath.set(relativePath, withheld);
        return withheld;
      };
      return {
        ...result,
        matches: result.matches.filter((match) => !isWithheld(match.path)),
        truncatedFiles: result.truncatedFiles.filter((path) => !isWithheld(path)),
      };
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
      const { workspaceRoot, normalizedPath } = resolveGuardedMutationPath(
        params.path,
        runtime,
        'returnNormalized',
        'gateway:fs.edit',
      );
      const result = await editWorkspaceFile(workspaceRoot, {
        path: normalizedPath,
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
