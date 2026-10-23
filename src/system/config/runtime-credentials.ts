import { assertDistinctCredentials, assertStrongCredential } from '../../shared/security/credentials.js';

export function assertStrongPostgresCredential(value: string, role: string): void {
  let password: string;
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error();
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error(`${role} must be a PostgreSQL URL containing a strong password credential`);
  }
  assertStrongCredential(password, `${role} password`);
}

/** Executed before owner-file hydration or opening any process listener. */
export function assertRuntimeCredentials(env: NodeJS.ProcessEnv): void {
  const credentials = Object.fromEntries([
    'API_KEY', 'ADMIN_TOKEN', 'GATEWAY_SESSION_HMAC_KEY', 'GATEWAY_COMPANION_AUTH_TOKEN',
    'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN', 'PSFN_BACKUP_ENCRYPTION_KEY',
    'SATELLITE_HUB_CONTROL_TOKEN', 'HUB_CONTROL_TOKEN', 'PSFN_API_KEY',
  ].map(role => [role, env[role]]));
  for (const [index, token] of (env.API_SATELLITE_KEYS?.split(',') ?? []).entries()) {
    credentials[`API_SATELLITE_KEYS[${index}]`] = token.trim();
  }
  assertDistinctCredentials(credentials);
  for (const role of ['POSTGRES_DATABASE_URL', 'PSFN_SHARED_MIGRATION_DATABASE_URL']) {
    if (env[role] !== undefined) assertStrongPostgresCredential(env[role], role);
  }
}
