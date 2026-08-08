export interface SanitizedPostgresConnection {
  connectionArg: string;
  password?: string;
}

const SUPPORTED_NON_CREDENTIAL_QUERY_PARAMETERS = new Set([
  'application_name',
  'channel_binding',
  'client_encoding',
  'connect_timeout',
  'dbname',
  'fallback_application_name',
  'host',
  'hostaddr',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'load_balance_hosts',
  'max_protocol_version',
  'min_protocol_version',
  'options',
  'port',
  'replication',
  'requirepeer',
  'requiressl',
  'ssl_max_protocol_version',
  'ssl_min_protocol_version',
  'ssl',
  'sslcompression',
  'sslcrl',
  'sslcrldir',
  'sslmode',
  'sslnegotiation',
  'sslrootcert',
  'sslsni',
  'target_session_attrs',
  'tcp_user_timeout',
  'user',
]);

const UNSUPPORTED_CREDENTIAL_QUERY_PARAMETERS = new Set([
  'gssdelegation',
  'gssencmode',
  'gsslib',
  'krbsrvname',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_issuer',
  'oauth_scope',
  'passfile',
  'require_auth',
  'scram_client_key',
  'scram_server_key',
  'service',
  'sslcert',
  'sslcertmode',
  'sslkey',
  'sslkeylogfile',
  'sslpassword',
]);

const FORCED_CONNECTION_PARAMETERS = [
  'sslcertmode=disable',
  'require_auth=%21gss%2C%21sspi',
] as const;

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function decodeUriComponent(value: string, context: string): string {
  try {
    // PostgreSQL connection URIs use RFC3986 query semantics. A literal plus
    // is data, not the application/x-www-form-urlencoded spelling of a space.
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${context} database URL contains malformed percent encoding`);
  }
}

function escapeRegExpCharacter(character: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

function encodedCredentialPattern(encoded: string): RegExp {
  let pattern = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index]!;
    if (character === '%' && /^[0-9A-F]{2}$/u.test(encoded.slice(index + 1, index + 3))) {
      const hex = encoded.slice(index + 1, index + 3);
      pattern += `%${[...hex].map(digit => (
        /[A-F]/u.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit
      )).join('')}`;
      index += 2;
    } else {
      pattern += escapeRegExpCharacter(character);
    }
  }
  return new RegExp(pattern, 'gu');
}

function formEncodeCredential(password: string): string {
  const prefix = 'password=';
  return new URLSearchParams({ password }).toString().slice(prefix.length);
}

export function redactPostgresCredential(message: string, password: string | undefined): string {
  if (!password) return message;
  const encodedSpellings = new Set([
    encodeURIComponent(password),
    formEncodeCredential(password),
  ]);
  let redacted = message.replaceAll(password, '[redacted]');
  for (const spelling of [...encodedSpellings].sort((left, right) => right.length - left.length)) {
    if (spelling !== password) {
      redacted = redacted.replace(encodedCredentialPattern(spelling), '[redacted]');
    }
  }
  return redacted;
}

/**
 * Builds a child environment that cannot inherit libpq credential, service,
 * target, or authentication controls. The connection URI is the sole source
 * of connection settings and its extracted password is the sole credential.
 */
export function createSanitizedPostgresChildEnv(
  password: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (normalizedName.startsWith('PG')) continue;
    if (normalizedName === 'KRB5CCNAME'
      || normalizedName === 'KRB5_CLIENT_KTNAME'
      || normalizedName === 'KRB5_KTNAME') {
      continue;
    }
    env[name] = value;
  }

  // A missing PGPASSFILE falls back to ~/.pgpass. Pointing it at the null
  // device makes the absence of an explicit URL password fail closed.
  env.PGPASSFILE = NULL_DEVICE;
  // Negated require_auth connection policy blocks GSS/SSPI. Overriding the
  // Kerberos credential cache to an always-empty in-memory ccache is defense
  // in depth for older clients so no ambient/inherited ticket cache is used.
  // MEMORY: is a self-contained, filesystem-free ccache: pointing this at a
  // character device such as FILE:/dev/null makes libpq's Kerberos probe read
  // an invalid ccache and segfault (observed as psql/pg_dump exit code 139).
  env.KRB5CCNAME = 'MEMORY:';
  if (password !== undefined) env.PGPASSWORD = password;
  return env;
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
  if (url.hash) {
    throw new Error(`${context} database URL must not contain a fragment`);
  }

  const userInfoPassword = url.password
    ? decodeUriComponent(url.password, context)
    : undefined;
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const retainedQuerySegments: string[] = [];
  const queryPasswords: string[] = [];
  for (const segment of rawQuery ? rawQuery.split('&') : []) {
    const equalsIndex = segment.indexOf('=');
    const rawName = equalsIndex >= 0 ? segment.slice(0, equalsIndex) : segment;
    const rawValue = equalsIndex >= 0 ? segment.slice(equalsIndex + 1) : '';
    const name = decodeUriComponent(rawName, context);
    if (UNSUPPORTED_CREDENTIAL_QUERY_PARAMETERS.has(name)) {
      throw new Error(`${context} database URL has an unsupported credential-bearing parameter`);
    }
    if (name === 'password') {
      queryPasswords.push(decodeUriComponent(rawValue, context));
    } else if (SUPPORTED_NON_CREDENTIAL_QUERY_PARAMETERS.has(name)) {
      if (name === 'dbname') {
        const databaseName = decodeUriComponent(rawValue, context);
        if (databaseName.includes('=') || /^postgres(?:ql)?:\/\//iu.test(databaseName)) {
          throw new Error(`${context} database URL has an unsupported credential-bearing parameter`);
        }
      }
      retainedQuerySegments.push(segment);
    } else {
      throw new Error(`${context} database URL has an unsupported database URL parameter`);
    }
  }
  if (queryPasswords.length > 1 || (userInfoPassword !== undefined && queryPasswords.length > 0)) {
    throw new Error(`${context} database URL has conflicting password sources`);
  }
  const password = userInfoPassword ?? queryPasswords.at(0);
  url.password = '';
  url.search = `?${[...retainedQuerySegments, ...FORCED_CONNECTION_PARAMETERS].join('&')}`;
  const connectionArg = url.toString();
  if (url.password) {
    throw new Error(`${context} could not produce a credential-free database URL`);
  }
  return { connectionArg, ...(password !== undefined ? { password } : {}) };
}
