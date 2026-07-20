import { resolve } from 'node:path';
import {
  resolveConfiguredCompanionDataDir,
  resolveSessionsDir,
} from '../../persistence/layout.js';
import { assertValidPostgresSchemaName } from '../../persistence/postgres.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { MaintenanceRuntime } from './cli-harness.js';

export class TestingSessionPurgeCompanionResolutionError extends Error {
  override readonly name = 'TestingSessionPurgeCompanionResolutionError';
}

export class TestingSessionPurgeSchemaResolutionError extends Error {
  override readonly name = 'TestingSessionPurgeSchemaResolutionError';
}

export interface TestingSessionPurgeTargetOptions {
  companionId?: string;
  dataDir?: string;
  sessionsDir?: string;
}

export interface TestingSessionPurgeTarget {
  companionDataDir: string;
  companionId?: string;
  postgresSchema: string;
  sessionsDir: string;
}

function requireTargetCompanionId(value: string | undefined, context: string): string {
  try {
    return createCompanionId(value, context);
  } catch (error) {
    throw new TestingSessionPurgeCompanionResolutionError(
      `${context} is required and must identify one fleet companion`,
      { cause: error },
    );
  }
}

function requireTargetSchema(value: string | undefined, companionId: string): string {
  const schema = value?.trim();
  if (!schema) {
    throw new TestingSessionPurgeSchemaResolutionError(
      `Cannot determine PostgreSQL schema for purge target companion ${companionId}`,
    );
  }
  try {
    return assertValidPostgresSchemaName(schema);
  } catch (error) {
    throw new TestingSessionPurgeSchemaResolutionError(
      `Invalid PostgreSQL schema for purge target companion ${companionId}`,
      { cause: error },
    );
  }
}

/**
 * Bind journals, Postgres, and Redis to one companion identity. Fleet mode
 * resolves both the companion data root and schema exclusively from the
 * validated companions.json projection; single-companion mode keeps public
 * as the explicit default schema.
 */
export function resolveTestingSessionPurgeTarget(
  runtime: Pick<MaintenanceRuntime, 'config' | 'dataDir'>,
  options: TestingSessionPurgeTargetOptions,
): TestingSessionPurgeTarget {
  const config = runtime.config;
  if (config.multiCompanion === true) {
    if (options.dataDir !== undefined) {
      throw new TestingSessionPurgeCompanionResolutionError(
        'Multi-companion session purge resolves companion data from companions.json; '
        + '--data-dir cannot override the manifest',
      );
    }
    const companionId = requireTargetCompanionId(
      options.companionId,
      '--companion-id in multi-companion mode',
    );
    const fleet = config.companionFleet;
    if (!fleet) {
      throw new TestingSessionPurgeCompanionResolutionError(
        'Multi-companion session purge requires the companions.json fleet manifest',
      );
    }
    const companion = fleet.companions.find(entry => entry.companionId === companionId);
    if (!companion) {
      throw new TestingSessionPurgeCompanionResolutionError(
        `Purge target companion ${companionId} is not present in companions.json`,
      );
    }
    const companionDataDir = resolve(companion.companionDataDir);
    const sessionsDir = resolve(resolveSessionsDir(companionDataDir));
    if (options.sessionsDir !== undefined && resolve(options.sessionsDir) !== sessionsDir) {
      throw new TestingSessionPurgeCompanionResolutionError(
        `--sessions-dir must match the manifest-owned sessions directory for ${companionId}`,
      );
    }
    return {
      companionDataDir,
      companionId,
      postgresSchema: requireTargetSchema(companion.postgresSchema, companionId),
      sessionsDir,
    };
  }

  const configuredCompanionId = typeof config.companionId === 'string'
    ? config.companionId
    : undefined;
  const companionId = options.companionId !== undefined
    ? requireTargetCompanionId(options.companionId, '--companion-id')
    : configuredCompanionId;
  if (
    options.companionId !== undefined
    && configuredCompanionId !== undefined
    && companionId !== configuredCompanionId
  ) {
    throw new TestingSessionPurgeCompanionResolutionError(
      `--companion-id ${companionId} does not match configured companion ${configuredCompanionId}`,
    );
  }
  const companionDataDir = resolve(
    options.dataDir !== undefined
      ? runtime.dataDir
      : resolveConfiguredCompanionDataDir(config),
  );
  const postgresSchema = requireTargetSchema(config.postgresSchema?.trim() || 'public', companionId ?? 'single');
  return {
    companionDataDir,
    ...(companionId ? { companionId } : {}),
    postgresSchema,
    sessionsDir: resolve(options.sessionsDir ?? resolveSessionsDir(companionDataDir)),
  };
}
