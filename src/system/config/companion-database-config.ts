import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';
import type {
  ResolvedCompanionFleetEntry,
  ResolvedCompanionsFleetConfig,
} from './companions-config.js';

export interface ResolvedCompanionDatabaseCredential {
  companion: ResolvedCompanionFleetEntry;
  databaseUrl: string;
  role: string;
}

export interface ResolvedCompanionDatabaseTopology {
  sharedMigration: {
    databaseUrl: string;
    role: string;
  };
  companions: ResolvedCompanionDatabaseCredential[];
}

function databaseIdentity(url: URL): string {
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
}

function resolveDatabaseCredential(
  vault: CredentialVaultPort,
  reference: ResolvedCompanionFleetEntry['postgresDatabaseUrlRef'],
  role: string,
  description: string,
): { value: string; url: URL } {
  const value = vault.resolveRequired(reference, description).trim();
  const parsed = parseExactPostgresCredential(value, description);
  if (parsed.username !== role) {
    throw new Error(`${description} must authenticate as configured role ${role}`);
  }
  return { value, url: parsed.url };
}

/** Resolve gateway-only topology secrets and prove exact credential fan-out. */
export function resolveCompanionDatabaseTopology(options: {
  fleet: ResolvedCompanionsFleetConfig;
  credentialVault: CredentialVaultPort;
  gatewayDatabaseUrl: string;
}): ResolvedCompanionDatabaseTopology {
  const sharedValue = options.credentialVault.resolveRequired(
    options.fleet.postgres.sharedMigrationDatabaseUrlRef,
    'Shared schema migration database credential',
  ).trim();
  const shared = parseExactPostgresCredential(
    sharedValue,
    'Shared schema migration database credential',
  );
  if (shared.username !== options.fleet.postgres.sharedMigrationRole) {
    throw new Error(
      'Shared schema migration database credential must authenticate as configured topology role '
      + options.fleet.postgres.sharedMigrationRole,
    );
  }
  const companions = options.fleet.companions.map((companion) => {
    const credential = resolveDatabaseCredential(
      options.credentialVault,
      companion.postgresDatabaseUrlRef,
      companion.postgresRole,
      `Companion ${companion.companionId} database credential`,
    );
    return {
      companion,
      databaseUrl: credential.value,
      role: companion.postgresRole,
      targetIdentity: databaseIdentity(credential.url),
    };
  });
  const urls = [sharedValue, ...companions.map(entry => entry.databaseUrl)];
  if (new Set(urls).size !== urls.length) {
    throw new Error('Multi-companion topology requires one distinct database credential per authority');
  }
  const targetIdentities = [databaseIdentity(shared.url), ...companions.map(entry => entry.targetIdentity)];
  if (new Set(targetIdentities).size !== 1) {
    throw new Error('Multi-companion topology database credentials must target the same exact database');
  }
  const gatewayDatabaseUrl = options.gatewayDatabaseUrl.trim();
  if (!companions.some(entry => entry.databaseUrl === gatewayDatabaseUrl)) {
    throw new Error(
      'Gateway POSTGRES_DATABASE_URL must exactly match one configured companion runtime credential',
    );
  }
  return {
    sharedMigration: {
      databaseUrl: sharedValue,
      role: options.fleet.postgres.sharedMigrationRole,
    },
    companions: companions.map(({ targetIdentity: _targetIdentity, ...entry }) => entry),
  };
}
