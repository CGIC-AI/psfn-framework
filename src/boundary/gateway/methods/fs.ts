import { JSONRPCErrorException } from 'json-rpc-2.0';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
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
  isBroadSearchGlob,
  normalizeListLimits,
  searchWorkspaceFiles,
} from '../../integrations/filesystem/workspace-ops.js';
import { normalizeFilesystemReadOptions } from '../../integrations/filesystem/ops.js';
import { readUtf8TextFilePageFromHandle } from '../../integrations/filesystem/text-file-paging.js';

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
): { workspaceRoot: string; normalizedPath: string; resolvedPath: string } {
  const workspaceRoot = resolveWorkspaceRoot(runtime.workspacePath);
  const normalizedPath = normalizeRequestedWorkspacePath(requestedPath, workspaceRoot);
  const resolvedPath = resolveWorkspaceFsPathFromRoot(normalizedPath, workspaceRoot);
  assertPersonalWorkspacePath(resolvedPath, runtime, missingPathBehavior);
  return { workspaceRoot, normalizedPath, resolvedPath };
}

interface GuardedMutationHandle {
  handle: FileHandle;
  revisionIsCurrent: () => boolean;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function openExistingGuardedMutationHandle(
  resolvedPath: string,
  runtime: GatewayMethodRuntime,
  via: 'gateway:fs.write' | 'gateway:fs.edit',
): Promise<GuardedMutationHandle> {
  const screenedStats = await stat(resolvedPath, { bigint: true });
  const guard = runtime.quarantinedArtifactGuard;
  const checked = guard?.checkMany(
    [resolvedPath],
    { via },
    {
      physicalIdentities: [
        `${screenedStats.dev.toString()}:${screenedStats.ino.toString()}`
        + `:${screenedStats.birthtimeNs.toString()}`,
      ],
    },
  );
  const verdict = checked?.verdicts[0];
  if (verdict?.withheld) {
    throw new JSONRPCErrorException(verdict.noticeText, GatewayErrors.POLICY_DENIED);
  }

  const handle = await open(resolvedPath, 'r+');
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (openedStats.dev !== screenedStats.dev
      || openedStats.ino !== screenedStats.ino
      || openedStats.birthtimeNs !== screenedStats.birthtimeNs) {
      throw new JSONRPCErrorException(
        `${via} candidate identity changed after quarantine screening; refusing mutation`,
        GatewayErrors.POLICY_DENIED,
      );
    }
    const revisionIsCurrent = (): boolean => !guard
      || !checked
      || guard.readRevisionToken() === checked.revisionToken;
    if (!revisionIsCurrent()) {
      throw new JSONRPCErrorException(
        `${via} quarantine state changed before mutation; refusing stale verdict`,
        GatewayErrors.POLICY_DENIED,
      );
    }
    return { handle, revisionIsCurrent };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openGuardedWriteHandle(
  resolvedPath: string,
  runtime: GatewayMethodRuntime,
): Promise<GuardedMutationHandle> {
  try {
    return await openExistingGuardedMutationHandle(
      resolvedPath,
      runtime,
      'gateway:fs.write',
    );
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }

  // Missing-target writes still consult path registration. Create with `wx`
  // so a held inode raced into place is never truncated; EEXIST is then
  // screened through the descriptor-identity path.
  assertQuarantinedArtifactMutationAllowed(resolvedPath, runtime, 'gateway:fs.write');
  try {
    const handle = await open(resolvedPath, 'wx+');
    try {
      const stats = await handle.stat({ bigint: true });
      const guard = runtime.quarantinedArtifactGuard;
      const checked = guard?.checkMany(
        [resolvedPath],
        { via: 'gateway:fs.write' },
        {
          physicalIdentities: [
            `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`,
          ],
        },
      );
      const verdict = checked?.verdicts[0];
      if (verdict?.withheld) {
        throw new JSONRPCErrorException(verdict.noticeText, GatewayErrors.POLICY_DENIED);
      }
      return {
        handle,
        revisionIsCurrent: () => !guard
          || !checked
          || guard.readRevisionToken() === checked.revisionToken,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    return await openExistingGuardedMutationHandle(
      resolvedPath,
      runtime,
      'gateway:fs.write',
    );
  }
}

async function replaceHandleContent(handle: FileHandle, content: string): Promise<void> {
  const bytes = Buffer.from(content, 'utf8');
  await handle.truncate(0);
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written);
    if (result.bytesWritten <= 0) {
      throw new Error('filesystem mutation made no write progress');
    }
    written += result.bytesWritten;
  }
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
      // fails with the fixed quarantine notice and records the attempt on the
      // Garden queue entry. A successful placeholder response would make the
      // gateway audit indistinguishable from a raw read later masked by the
      // scheduler, weakening the live containment proof.
      const options = normalizeFilesystemReadOptions({
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        ...(params.offsetBytes !== undefined ? { offsetBytes: params.offsetBytes } : {}),
      });
      const screenedStats = await stat(resolved.path, { bigint: true });
      const guard = runtime.quarantinedArtifactGuard;
      const checked = guard?.checkMany(
        [resolved.path],
        { via: 'gateway:fs.read' },
        {
          physicalIdentities: [
            `${screenedStats.dev.toString()}:${screenedStats.ino.toString()}`
            + `:${screenedStats.birthtimeNs.toString()}`,
          ],
        },
      );
      const guardVerdict = checked?.verdicts[0];
      if (guardVerdict?.withheld) {
        throw new JSONRPCErrorException(
          guardVerdict.noticeText,
          GatewayErrors.POLICY_DENIED,
        );
      }
      const handle = await open(resolved.path, 'r');
      try {
        const stats = await handle.stat({ bigint: true });
        if (stats.dev !== screenedStats.dev
          || stats.ino !== screenedStats.ino
          || stats.birthtimeNs !== screenedStats.birthtimeNs) {
          throw new JSONRPCErrorException(
            'fs.read candidate identity changed after quarantine screening; refusing read',
            GatewayErrors.POLICY_DENIED,
          );
        }
        const result = await readUtf8TextFilePageFromHandle(
          handle,
          options.maxBytes,
          options.offsetBytes,
        );
        if (guard && checked && guard.readRevisionToken() !== checked.revisionToken) {
          throw new JSONRPCErrorException(
            'fs.read quarantine state changed during the read; refusing stale content',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return result;
      } finally {
        await handle.close();
      }
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
    prePolicyGuard: (params: FsWriteParams, runtime) => {
      const guard = runtime.personaMutationAttemptGuard;
      if (!guard) return;
      const detections = guard.inspectFilesystemMutation({
        companionId: runtime.authenticatedCompanionId() ?? '',
        tool: 'fs.write',
        requestedPath: params.path,
        workspacePath: runtime.workspacePath,
      });
      if (detections.length > 0) {
        throw new JSONRPCErrorException(
          'Direct persona mutation is blocked; use the governed identity tool.',
          GatewayErrors.POLICY_DENIED,
        );
      }
    },
    handler: async (params: FsWriteParams, runtime) => {
      const { workspaceRoot, resolvedPath } = resolveGuardedMutationPath(
        params.path,
        runtime,
        'resolveParent',
      );
      let guarded: GuardedMutationHandle | undefined;
      try {
        guarded = await openGuardedWriteHandle(resolvedPath, runtime);
        if (!guarded.revisionIsCurrent()) {
          throw new JSONRPCErrorException(
            'fs.write quarantine state changed before mutation; refusing stale verdict',
            GatewayErrors.POLICY_DENIED,
          );
        }
        await replaceHandleContent(guarded.handle, params.content);
        if (!guarded.revisionIsCurrent()) {
          throw new JSONRPCErrorException(
            'fs.write quarantine state changed during mutation; refusing a stale success result',
            GatewayErrors.POLICY_DENIED,
          );
        }
      } catch (error) {
        if (error instanceof JSONRPCErrorException) throw error;
        throw new JSONRPCErrorException(
          await buildWriteFailureMessage(params.path, workspaceRoot, resolvedPath, error),
          GatewayErrors.PROVIDER_ERROR,
        );
      } finally {
        await guarded?.handle.close();
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
      return await searchWorkspaceFiles(searchRoot, {
        query: params.query,
        ...(typeof params.glob === 'string' && !isBroadSearchGlob(params.glob)
          ? { glob: params.glob }
          : { glob: resolveDefaultSearchGlob(runtime) }),
        ...(params.mode ? { mode: params.mode } : {}),
        ...(typeof params.maxMatches === 'number' ? { maxMatches: params.maxMatches } : {}),
        ...(typeof params.maxFiles === 'number' ? { maxFiles: params.maxFiles } : {}),
        ...(typeof params.maxBytesPerFile === 'number' ? { maxBytesPerFile: params.maxBytesPerFile } : {}),
        ...(typeof params.contextLines === 'number' ? { contextLines: params.contextLines } : {}),
        // hrmrq.54: guard before the integration opens or reads a candidate.
        // Post-search filtering still lets quarantined matches consume limits,
        // turning result shape into a boolean content oracle.
        ...(runtime.quarantinedArtifactGuard
          ? {
            screenFileReads: (candidates: readonly {
              absolutePath: string;
              physicalIdentity: string;
            }[]) => {
              const guard = runtime.quarantinedArtifactGuard!;
              const checked = guard.checkMany(
                candidates.map(candidate => candidate.absolutePath),
                { via: 'gateway:fs.search' },
                { physicalIdentities: candidates.map(candidate => candidate.physicalIdentity) },
              );
              return {
                readable: checked.verdicts.map(verdict => !verdict.withheld),
                revisionIsCurrent: () => guard.readRevisionToken() === checked.revisionToken,
              };
            },
          }
          : {}),
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
    prePolicyGuard: (params: FsEditParams, runtime) => {
      const guard = runtime.personaMutationAttemptGuard;
      if (!guard) return;
      const detections = guard.inspectFilesystemMutation({
        companionId: runtime.authenticatedCompanionId() ?? '',
        tool: 'fs.edit',
        requestedPath: params.path,
        workspacePath: runtime.workspacePath,
      });
      if (detections.length > 0) {
        throw new JSONRPCErrorException(
          'Direct persona mutation is blocked; use the governed identity tool.',
          GatewayErrors.POLICY_DENIED,
        );
      }
    },
    handler: async (params: FsEditParams, runtime) => {
      const { resolvedPath } = resolveGuardedMutationPath(
        params.path,
        runtime,
        'returnNormalized',
      );
      if (typeof params.oldText !== 'string' || params.oldText.length === 0) {
        throw new Error('fs edit requires a non-empty oldText');
      }
      const guarded = await openExistingGuardedMutationHandle(
        resolvedPath,
        runtime,
        'gateway:fs.edit',
      );
      try {
        const content = await guarded.handle.readFile({ encoding: 'utf8' });
        if (!guarded.revisionIsCurrent()) {
          throw new JSONRPCErrorException(
            'fs.edit quarantine state changed during the read; refusing stale content verdict',
            GatewayErrors.POLICY_DENIED,
          );
        }
        const parts = content.split(params.oldText);
        const occurrences = parts.length - 1;
        if (occurrences <= 0) {
          throw new Error('fs edit could not find oldText in the target file');
        }
        if (params.replaceAll !== true && occurrences !== 1) {
          throw new Error(
            'fs edit found multiple matches; retry with replaceAll=true or use a more specific oldText',
          );
        }
        const nextContent = params.replaceAll === true
          ? parts.join(params.newText)
          : content.replace(params.oldText, params.newText);
        if (nextContent !== content) {
          if (!guarded.revisionIsCurrent()) {
            throw new JSONRPCErrorException(
              'fs.edit quarantine state changed before mutation; refusing stale verdict',
              GatewayErrors.POLICY_DENIED,
            );
          }
          await replaceHandleContent(guarded.handle, nextContent);
        }
        if (!guarded.revisionIsCurrent()) {
          throw new JSONRPCErrorException(
            'fs.edit quarantine state changed during mutation; refusing a content-derived result',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return {
          success: true,
          replacements: params.replaceAll === true ? occurrences : 1,
        };
      } finally {
        await guarded.handle.close();
      }
    },
    summary: (p: FsEditParams) => ({ path: p.path, replaceAll: p.replaceAll === true }),
    approvalAction: 'write',
    approvalScope: (p: FsEditParams) => p.path,
  },
];

export function registerFilesystemMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, fsDescriptors);
}
