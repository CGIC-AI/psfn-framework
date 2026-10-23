import { assertDistinctCredentials, assertStrongCredential, parseStrongSessionHmacRotationKeys } from '../../shared/security/credentials.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';

export function assertStrongPostgresCredential(value: string, role: string): void {
  const { url } = parseExactPostgresCredential(value, role);
  let password: string;
  try {
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
  if (env.GATEWAY_SESSION_HMAC_KEYS !== undefined) {
    for (const key of parseStrongSessionHmacRotationKeys(env.GATEWAY_SESSION_HMAC_KEYS)) {
      // A singular HMAC and its versioned entry are the same role. Every
      // rotation key must still differ from API/admin/all other roles.
      assertDistinctCredentials({ ...credentials, GATEWAY_SESSION_HMAC_KEY: undefined,
        GATEWAY_SESSION_HMAC_KEYS: key });
    }
  }
  for (const role of ['POSTGRES_DATABASE_URL', 'PSFN_SHARED_MIGRATION_DATABASE_URL']) {
    if (env[role] !== undefined) assertStrongPostgresCredential(env[role], role);
  }
}
