export const POSTGRES_VECTOR_EXTENSION_MIGRATION = `
  DO $$
  DECLARE
    installed_schema TEXT;
    requires_extension_schema BOOLEAN :=
      current_schema() <> 'public'
      OR 'extensions' = ANY (current_schemas(false));
    target_schema TEXT;
  BEGIN
    SELECT namespace.nspname INTO installed_schema
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'vector';

    IF installed_schema IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
      ) THEN
        RAISE EXCEPTION
          'pgvector is not installed in either acceptable schema: public or extensions; PostgreSQL extension vector is unavailable';
      END IF;
      target_schema := CASE
        WHEN requires_extension_schema THEN 'extensions'
        ELSE 'public'
      END;
      IF target_schema = 'extensions' AND to_regnamespace('extensions') IS NULL THEN
        RAISE EXCEPTION 'Tenant migrations require the explicitly provisioned extensions schema';
      END IF;
      EXECUTE format('CREATE EXTENSION vector WITH SCHEMA %I', target_schema);
    ELSIF installed_schema NOT IN ('public', 'extensions') THEN
      RAISE EXCEPTION
        'pgvector is installed in schema %, expected public or extensions',
        installed_schema;
    ELSIF requires_extension_schema AND installed_schema = 'public' THEN
      RAISE EXCEPTION
        'pgvector is installed in public; tenant migrations require extensions';
    END IF;
  END
  $$;
`;
