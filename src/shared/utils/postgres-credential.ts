const DATABASE_CREDENTIAL_QUERY_OVERRIDES = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'user',
  'password',
  'service',
  'servicefile',
  'passfile',
  'options',
  'target_session_attrs',
]);

export interface ExactPostgresCredential {
  url: URL;
  username: string;
}

/** Parse one non-routed PostgreSQL credential whose target is unambiguous. */
export function parseExactPostgresCredential(
  databaseUrl: string,
  context: string,
): ExactPostgresCredential {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`${context} must be a PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${context} must be a PostgreSQL URL`);
  }
  const override = [...url.searchParams.keys()].find(parameter => (
    DATABASE_CREDENTIAL_QUERY_OVERRIDES.has(parameter.toLowerCase())
  ));
  if (override) {
    throw new Error(
      `${context} must not use PostgreSQL routing or authentication query override ${override}`,
    );
  }
  if (!url.hostname || !url.pathname || url.pathname === '/' || !url.username || !url.password) {
    throw new Error(`${context} must identify one authenticated PostgreSQL database`);
  }
  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${context} contains a malformed PostgreSQL role name`);
  }
  return { url, username };
}
