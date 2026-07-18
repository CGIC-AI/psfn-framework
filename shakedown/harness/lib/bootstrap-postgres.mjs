const DEFAULT_POSTGRES_PORT = '5432';
const DEFAULT_DATABASES = new Set(['postgres', 'template0', 'template1']);
const DEFAULT_SCHEMAS = new Set(['public', 'pg_catalog', 'information_schema']);
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;

function parsePostgresUrl(rawValue, label) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${label} must be an absolute PostgreSQL URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${label} must use postgres:// or postgresql://`);
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must identify a PostgreSQL host`);
  }
  if (parsed.hash) {
    throw new Error(`${label} must not contain a fragment`);
  }
  for (const forbidden of ['options', 'role', 'search_path', 'session_authorization']) {
    if (parsed.searchParams.has(forbidden)) {
      throw new Error(`${label} must not override PostgreSQL role or schema routing via "${forbidden}"`);
    }
  }

  const rawDatabase = parsed.pathname.replace(/^\/+/u, '');
  if (!rawDatabase || rawDatabase.includes('/')) {
    throw new Error(`${label} must identify exactly one database`);
  }
  let database;
  try {
    database = decodeURIComponent(rawDatabase);
  } catch {
    throw new Error(`${label} contains an invalid encoded database name`);
  }
  if (!database || /[\u0000-\u001f\u007f]/u.test(database)) {
    throw new Error(`${label} contains an invalid database name`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || DEFAULT_POSTGRES_PORT;
  const endpointHost = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return {
    endpoint: `${endpointHost}:${port}`,
    database,
    hostname,
    port,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: Object.fromEntries(
      ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']
        .flatMap(name => parsed.searchParams.has(name) ? [[name, parsed.searchParams.get(name)]] : []),
    ),
  };
}

function requireDedicatedSchema(rawSchema) {
  const schema = rawSchema.trim();
  if (!SCHEMA_PATTERN.test(schema) || DEFAULT_SCHEMAS.has(schema) || schema.startsWith('pg_')) {
    throw new Error(
      `COMPANION_PG_SCHEMA must be a dedicated non-default schema; received "${rawSchema}"`,
    );
  }
  return schema;
}

export function resolvePostgresTargetContract({
  postgresUrl,
  livePostgresUrl,
  expectedDatabase,
  schema: rawSchema,
}) {
  const round = parsePostgresUrl(postgresUrl, 'POSTGRES_DATABASE_URL');
  const live = parsePostgresUrl(livePostgresUrl, 'PSFN_LIVE_POSTGRES_DATABASE_URL');
  const schema = requireDedicatedSchema(rawSchema);
  if (!round.username) {
    throw new Error('POSTGRES_DATABASE_URL must name the dedicated shakedown database role');
  }
  if (round.database !== expectedDatabase) {
    throw new Error(
      `PSFN_SHAKEDOWN_POSTGRES_DATABASE "${expectedDatabase}" does not match `
      + `POSTGRES_DATABASE_URL database "${round.database}"`,
    );
  }
  if (DEFAULT_DATABASES.has(round.database.toLowerCase())) {
    throw new Error(
      `POSTGRES_DATABASE_URL selects default PostgreSQL database "${round.database}", not a disposable round database`,
    );
  }
  if (round.endpoint === live.endpoint && round.database === live.database) {
    throw new Error(
      'POSTGRES_DATABASE_URL selects the same database as the protected live target; '
      + 'a shakedown requires a dedicated database.',
    );
  }

  return {
    connection: round,
    identity: {
      endpoint: round.endpoint,
      database: round.database,
      schema,
      role: round.username,
    },
  };
}

export async function verifyDisposablePostgresTarget({
  contract,
  resume,
  probe,
}) {
  const observed = await probe(contract);
  if (observed.database !== contract.identity.database) {
    throw new Error(
      `PostgreSQL isolation probe reported database "${observed.database}", `
      + `expected "${contract.identity.database}"`,
    );
  }
  if (observed.role !== contract.identity.role) {
    throw new Error(
      `PostgreSQL isolation probe reported role "${observed.role}", expected "${contract.identity.role}"`,
    );
  }
  if (
    !Number.isInteger(observed.userTableCount)
    || observed.userTableCount < 0
    || typeof observed.schemaExists !== 'boolean'
  ) {
    throw new Error('PostgreSQL isolation probe returned an invalid user-table count');
  }
  if (!resume && observed.userTableCount !== 0) {
    throw new Error(
      `PostgreSQL target is not disposable: fresh database already contains `
      + `${observed.userTableCount} user table(s)`,
    );
  }
  return contract.identity;
}
