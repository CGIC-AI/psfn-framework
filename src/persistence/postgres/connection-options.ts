export interface PostgresConnectionOptions {
  applicationName?: string;
  allowExitOnIdle?: boolean;
  connectionTimeoutMillis?: number;
  max?: number;
  /**
   * Pin every session opened by this pool to PostgreSQL's read-only
   * transaction posture. This is a session fence, not a substitute for exact
   * schema/table ACLs; callers that cross a tenant boundary must prove both.
   */
  readOnly?: boolean;
  /**
   * Optional companion/world schema. When provided it is strictly validated and
   * pinned as the pool's search_path at connection startup (libpq `options`), so
   * every connection handed out by the pool operates inside that schema and no
   * connection can escape it. Extension types resolve only through the
   * dedicated `extensions` schema. `public` is deliberately absent so a
   * missing tenant table fails instead of falling through to legacy data.
   *
   * When absent, no search_path is set and behavior is byte-identical to the
   * default (`"$user", public`).
   */
  schema?: string;
  /**
   * Optional least-privilege role selected at connection startup. A role is
   * accepted only together with an explicit schema so it can never inherit the
   * database's public search path.
   */
  role?: string;
}
