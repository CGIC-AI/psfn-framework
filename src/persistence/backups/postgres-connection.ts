export interface SanitizedPostgresConnection {
  connectionArg: string;
  password?: string;
}

/**
 * Produces a credential-free Postgres URI for child argv and extracts the one
 * supported password source for PGPASSWORD. Ambiguous password sources fail
 * closed rather than choosing one silently.
 */
export function sanitizePostgresConnection(
  databaseUrl: string,
  context: string,
): SanitizedPostgresConnection {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      `${context} requires a URL connection string (postgres://…) so credentials stay out of process arguments`,
    );
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${context} database URL must use postgres:// or postgresql://`);
  }

  const userInfoPassword = url.password ? decodeURIComponent(url.password) : undefined;
  const queryPasswords = url.searchParams.getAll('password');
  if (queryPasswords.length > 1 || (userInfoPassword !== undefined && queryPasswords.length > 0)) {
    throw new Error(`${context} database URL has conflicting password sources`);
  }
  const password = userInfoPassword ?? queryPasswords.at(0);
  url.password = '';
  url.searchParams.delete('password');
  const connectionArg = url.toString();
  if (url.password || url.searchParams.has('password')) {
    throw new Error(`${context} could not produce a credential-free database URL`);
  }
  return { connectionArg, ...(password !== undefined ? { password } : {}) };
}
