import { statSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_AUTH_FILE_NAME } from './fleet-auth-config.js';
import type { OwnerFileSeedDescriptor } from './startup-owner-files.js';

/**
 * Canonical POSIX mode authority for startup owner files.
 *
 * The rollout runbook and the post-rollout gate used to assume every owner
 * file is `999:999 664`. The startup-valid fleet deliberately carries
 * sensitivity-specific modes, so this module is the single authority both the
 * runbook and the validators derive from:
 *
 * - auth-adjacent owners (fleet-auth.json carries the fleet SSO roster and its
 *   credential material) are owner-only `0600`;
 * - per-companion policy owners (capability-tier, scheduler, charge-policy,
 *   skills) are group-readable `0640`;
 * - every remaining fleet-shared system owner is `0644`.
 *
 * Ownership is not a per-file policy value: every owner file must belong to
 * the runtime identity that reads it (uid/gid 999 in the chart), so the
 * verifier compares against the expected runtime uid/gid rather than a table.
 */
export const OWNER_FILE_MODE_AUTH_ADJACENT = 0o600;
export const OWNER_FILE_MODE_COMPANION_POLICY = 0o640;
export const OWNER_FILE_MODE_FLEET_SHARED = 0o644;

export function canonicalOwnerFileMode(input: {
  ownerFileName: string;
  scope: 'system' | 'companion';
}): number {
  if (input.scope === 'companion') {
    return OWNER_FILE_MODE_COMPANION_POLICY;
  }
  if (input.ownerFileName === FLEET_AUTH_FILE_NAME) {
    return OWNER_FILE_MODE_AUTH_ADJACENT;
  }
  return OWNER_FILE_MODE_FLEET_SHARED;
}

/** Render a POSIX mode the way `stat -c '%a'` and the runbook do. */
export function formatOwnerFileMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

export interface OwnerFileModeExpectation {
  label: string;
  path: string;
  canonicalMode: number;
  optionalWhenMissing: boolean;
}

export interface OwnerFileModeObservation {
  label: string;
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

export interface OwnerFileModeVerificationResult {
  ok: boolean;
  errors: string[];
  /** Files whose mode and ownership matched the canonical contract. */
  verified: OwnerFileModeObservation[];
  /** Optional-when-missing owners that are absent (not an error). */
  skippedMissingOptional: string[];
}

/**
 * Expand the static owner-file descriptors into per-file expectations for one
 * deployment: every system owner once at the system root, plus every
 * companion-scoped owner at each exact companion root.
 */
export function buildOwnerFileModeExpectations(input: {
  dataDir: string;
  companionRoots: ReadonlyArray<{ companionId?: string; companionDataDir: string }>;
  descriptors: readonly OwnerFileSeedDescriptor[];
}): OwnerFileModeExpectation[] {
  const expectations: OwnerFileModeExpectation[] = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.scope === 'system') {
      expectations.push({
        label: descriptor.label,
        path: join(input.dataDir, descriptor.ownerFileName),
        canonicalMode: descriptor.canonicalMode,
        optionalWhenMissing: descriptor.optionalWhenMissing,
      });
      continue;
    }
    for (const root of input.companionRoots) {
      expectations.push({
        label: root.companionId
          ? `companion ${root.companionId} ${descriptor.label}`
          : descriptor.label,
        path: join(root.companionDataDir, descriptor.ownerFileName),
        canonicalMode: descriptor.canonicalMode,
        optionalWhenMissing: descriptor.optionalWhenMissing,
      });
    }
  }
  return expectations;
}

function runtimeOwnerIdentity(): { uid: number; gid: number } | undefined {
  if (typeof process.geteuid !== 'function' || typeof process.getegid !== 'function') {
    return undefined;
  }
  return { uid: process.geteuid(), gid: process.getegid() };
}

/**
 * Stat every expected owner file and reject real ownership/mode drift. The
 * expected owner defaults to the current runtime identity: the preflight runs
 * in the workload that reads the files, so anything it does not own (for
 * example a root-owned rewrite) is exactly the EACCES drift the contract
 * exists to catch.
 */
export function verifyOwnerFileModes(
  expectations: readonly OwnerFileModeExpectation[],
  options: { expectedOwner?: { uid: number; gid: number } } = {},
): OwnerFileModeVerificationResult {
  const expectedOwner = options.expectedOwner ?? runtimeOwnerIdentity();
  const errors: string[] = [];
  const verified: OwnerFileModeObservation[] = [];
  const skippedMissingOptional: string[] = [];

  for (const expectation of expectations) {
    let stat;
    try {
      stat = statSync(expectation.path);
    } catch (error) {
      if (
        expectation.optionalWhenMissing
        && typeof error === 'object'
        && error !== null
        && (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        skippedMissingOptional.push(expectation.path);
        continue;
      }
      errors.push(
        `${expectation.label} owner-file mode check failed at ${expectation.path}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const actualMode = stat.mode & 0o777;
    if (actualMode !== expectation.canonicalMode) {
      errors.push(
        `${expectation.label} owner-file mode drift at ${expectation.path}: `
        + `expected ${formatOwnerFileMode(expectation.canonicalMode)}, `
        + `found ${formatOwnerFileMode(actualMode)}`,
      );
      continue;
    }
    if (expectedOwner && (stat.uid !== expectedOwner.uid || stat.gid !== expectedOwner.gid)) {
      errors.push(
        `${expectation.label} owner-file ownership drift at ${expectation.path}: `
        + `expected ${expectedOwner.uid}:${expectedOwner.gid}, found ${stat.uid}:${stat.gid}`,
      );
      continue;
    }
    verified.push({
      label: expectation.label,
      path: expectation.path,
      mode: actualMode,
      uid: stat.uid,
      gid: stat.gid,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    verified,
    skippedMissingOptional,
  };
}
