import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isStrictSubpath } from '../../persistence/layout.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';

const WORKSPACES_DIR_NAME = 'workspaces';
const PERSONAL_WORKSPACES_DIR_NAME = 'personal';
const SHARED_WORKSPACE_DIR_NAME = 'shared';

export interface ResolvedCompanionWorkspaceLayout {
  workspacesRoot: string;
  sharedWorkspacePath: string;
  personalWorkspaceByCompanionId: ReadonlyMap<CompanionId, string>;
}

export interface ProtectedWorkspaceRoot {
  label: string;
  path: string;
}

function pathsOverlap(first: string, second: string): boolean {
  const resolvedFirst = resolve(first);
  const resolvedSecond = resolve(second);
  return resolvedFirst === resolvedSecond
    || isStrictSubpath(resolvedFirst, resolvedSecond)
    || isStrictSubpath(resolvedSecond, resolvedFirst);
}

/**
 * Resolve a possibly-not-yet-created path through its nearest existing
 * ancestor and prove that the resulting canonical path remains beneath root.
 */
export function resolveCanonicalPathInsideRoot(
  candidatePath: string,
  root: string,
  field: string,
): string {
  const resolvedRoot = realpathSync(root);
  const requested = resolve(candidatePath);
  if (!isStrictSubpath(requested, resolvedRoot)) {
    throw new Error(
      `Invalid companions config: ${field} must resolve beneath persistence root ${resolvedRoot}, `
      + `got ${requested}`,
    );
  }

  let existingAncestor = requested;
  while (!existsSync(existingAncestor)) {
    const parent = resolve(existingAncestor, '..');
    if (parent === existingAncestor || !isStrictSubpath(parent, resolvedRoot)) {
      existingAncestor = resolvedRoot;
      break;
    }
    existingAncestor = parent;
  }

  const realAncestor = realpathSync(existingAncestor);
  if (realAncestor !== resolvedRoot && !isStrictSubpath(realAncestor, resolvedRoot)) {
    throw new Error(
      `Invalid companions config: ${field} resolves through a symlink outside persistence root `
      + `${resolvedRoot}`,
    );
  }

  const canonicalPath = resolve(realAncestor, relative(existingAncestor, requested));
  if (!isStrictSubpath(canonicalPath, resolvedRoot)) {
    throw new Error(
      `Invalid companions config: ${field} must resolve beneath persistence root ${resolvedRoot}, `
      + `got ${canonicalPath}`,
    );
  }
  return canonicalPath;
}

/**
 * Derive the installation-owned workspace layout. The fleet owner file does
 * not carry mutable path overrides: companion UUIDs deterministically select
 * one personal root and there is exactly one shared root per runtime.
 */
export function resolveCompanionWorkspaceLayout(input: {
  runtimeRoot: string;
  companionIds: readonly CompanionId[];
  protectedRoots?: readonly ProtectedWorkspaceRoot[];
}): ResolvedCompanionWorkspaceLayout {
  const runtimeRoot = realpathSync(input.runtimeRoot);
  const workspacesRoot = resolveCanonicalPathInsideRoot(
    resolve(runtimeRoot, WORKSPACES_DIR_NAME),
    runtimeRoot,
    'workspaces root',
  );
  const sharedWorkspacePath = resolveCanonicalPathInsideRoot(
    resolve(workspacesRoot, SHARED_WORKSPACE_DIR_NAME),
    runtimeRoot,
    'Shared Companion Workspace',
  );
  const personalWorkspaceByCompanionId = new Map<CompanionId, string>();

  for (const companionId of input.companionIds) {
    const personalWorkspacePath = resolveCanonicalPathInsideRoot(
      resolve(workspacesRoot, PERSONAL_WORKSPACES_DIR_NAME, companionId),
      runtimeRoot,
      `Personal Workspace for companion ${companionId}`,
    );
    for (const [otherCompanionId, otherPath] of personalWorkspaceByCompanionId) {
      if (pathsOverlap(personalWorkspacePath, otherPath)) {
        throw new Error(
          `Invalid companions config: Personal Workspace for companion ${companionId} `
          + `must not overlap Personal Workspace for companion ${otherCompanionId}`,
        );
      }
    }
    if (pathsOverlap(personalWorkspacePath, sharedWorkspacePath)) {
      throw new Error(
        `Invalid companions config: Personal Workspace for companion ${companionId} `
        + 'must not overlap the Shared Companion Workspace',
      );
    }
    personalWorkspaceByCompanionId.set(companionId, personalWorkspacePath);
  }

  for (const protectedRoot of input.protectedRoots ?? []) {
    for (const [companionId, personalWorkspacePath] of personalWorkspaceByCompanionId) {
      if (pathsOverlap(personalWorkspacePath, protectedRoot.path)) {
        throw new Error(
          `Invalid companions config: Personal Workspace for companion ${companionId} `
          + `must not overlap ${protectedRoot.label} (${resolve(protectedRoot.path)})`,
        );
      }
    }
    if (pathsOverlap(sharedWorkspacePath, protectedRoot.path)) {
      throw new Error(
        `Invalid companions config: Shared Companion Workspace must not overlap `
        + `${protectedRoot.label} (${resolve(protectedRoot.path)})`,
      );
    }
  }

  return {
    workspacesRoot,
    sharedWorkspacePath,
    personalWorkspaceByCompanionId,
  };
}
