import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  companionsFilePath,
  resolveCompanionFleetPaths,
  saveCompanionsConfig,
  validateCompanionsConfig,
  type CompanionFleetEntry,
  type CompanionsFleetConfig,
} from '../config/companions-config.js';
import { resolveCanonicalPathInsideRoot } from '../config/companion-workspace-layout.js';
import { verifyCompanionStartupOwnerFiles } from '../config/startup-owner-files.js';
import { FleetLifecycleError, sha256Hex } from './contracts.js';
import type {
  FleetPrerequisitePort,
  FleetTopologyPort,
  FleetWorkloadPort,
} from './ports.js';

function canonicalBytes(config: CompanionsFleetConfig): string {
  // Byte-identical to saveCompanionsConfig's writeJsonAtomic output.
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * companions.json in the system data directory is the canonical roster. The
 * revision is the SHA-256 of its exact bytes; publication is a lock-guarded
 * compare-and-swap through the canonical validator and atomic writer.
 */
export function createFileFleetTopologyPort(systemDataDir: string): FleetTopologyPort {
  const path = companionsFilePath(systemDataDir);
  const readCurrent = () => {
    if (!existsSync(path)) {
      throw new FleetLifecycleError('stale_topology', 'companions.json is missing; the fleet manifest is required');
    }
    const bytes = readFileSync(path);
    const config = validateCompanionsConfig(JSON.parse(bytes.toString('utf8')) as unknown, path);
    return { config, revision: sha256Hex(bytes) };
  };
  return {
    read: readCurrent,
    revisionOf: config => sha256Hex(canonicalBytes(validateCompanionsConfig(config, 'companions.json (planned)'))),
    publish(next, expectedRevision) {
      const lockPath = `${path}.lifecycle.lock`;
      let lock: number;
      try {
        lock = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new FleetLifecycleError(
          'topology_conflict',
          `Roster lock ${lockPath} is held; remove it only if no lifecycle apply is running`,
        );
      }
      try {
        if (readCurrent().revision !== expectedRevision) {
          throw new FleetLifecycleError('stale_topology', 'companions.json changed before publication');
        }
        return sha256Hex(canonicalBytes(saveCompanionsConfig(systemDataDir, next)));
      } finally {
        closeSync(lock);
        unlinkSync(lockPath);
      }
    },
  };
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Local (single-host) prerequisite checks. Credential references are checked
 * for presence only; values are handed to the tenant probe and never stored.
 */
export function createLocalFleetPrerequisitePort(input: {
  readonly persistenceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  /** Proves the tenant schema exists and is owned by the entry's runtime role. */
  readonly verifyTenantSchema: (input: {
    readonly databaseUrl: string;
    readonly postgresSchema: string;
    readonly postgresRole: string;
  }) => Promise<void>;
}): FleetPrerequisitePort {
  const requireEnv = (envName: string): string => {
    const value = input.env[envName]?.trim();
    if (!value) {
      throw new FleetLifecycleError('secret_ref_missing', `Credential reference ${envName} is not provisioned`);
    }
    return value;
  };
  const insideRoot = (relativePath: string, field: string): string => {
    try {
      return resolveCanonicalPathInsideRoot(resolve(input.persistenceRoot, relativePath), input.persistenceRoot, field);
    } catch (error) {
      throw new FleetLifecycleError('owner_roots_missing', error instanceof Error ? error.message : String(error));
    }
  };
  return {
    async verifySecretRefs(entry: CompanionFleetEntry, topology: CompanionsFleetConfig) {
      requireEnv(entry.postgresDatabaseUrlRef.envName);
      requireEnv(topology.postgres.sharedMigrationDatabaseUrlRef.envName);
    },
    async verifyTenant(entry: CompanionFleetEntry) {
      try {
        await input.verifyTenantSchema({
          databaseUrl: requireEnv(entry.postgresDatabaseUrlRef.envName),
          postgresSchema: entry.postgresSchema,
          postgresRole: entry.postgresRole,
        });
      } catch (error) {
        if (error instanceof FleetLifecycleError) throw error;
        throw new FleetLifecycleError('tenant_unverified', error instanceof Error ? error.message : String(error));
      }
    },
    async verifyOwnerRoots(entry: CompanionFleetEntry) {
      const dataDir = insideRoot(entry.companionDataDir, 'companionDataDir');
      const cardPath = insideRoot(entry.characterCardPath, 'characterCardPath');
      if (!isDirectory(dataDir) || !existsSync(cardPath) || !statSync(cardPath).isFile()) {
        throw new FleetLifecycleError('owner_roots_missing', 'Companion data root and character card must exist');
      }
      const verification = verifyCompanionStartupOwnerFiles({
        companionDataDir: dataDir,
        companionLabel: entry.companionId,
      });
      if (!verification.ok) {
        throw new FleetLifecycleError('owner_roots_missing', verification.errors.join('; '));
      }
    },
    async verifyWorkspace(_entry: CompanionFleetEntry, next: CompanionsFleetConfig) {
      try {
        resolveCompanionFleetPaths(next, input.persistenceRoot);
      } catch (error) {
        throw new FleetLifecycleError('workspace_invalid', error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/**
 * Local supervisor: workspaces are provisioned and agents are started from the
 * roster at (re)start, so the only honest outcome is an explicit restart.
 */
export function createLocalFleetWorkloadPort(): FleetWorkloadPort {
  return {
    verifyPrerequisites: async () => 'restart_required',
    drain: async () => 'restart_required',
  };
}
